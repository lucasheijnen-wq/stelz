#!/usr/bin/env python3
"""Archive the roster's Instagram FEED posts — carousels, photos and reels.

The stories archive (62) covers the 24-hour surface and nothing else. A can in
a carousel's third slide, or in a reel, is invisible to this tool today: the
creator-scan that would find it runs in a Cloud Function that is not deployed.

    ./firebase/functions/venv/bin/python \\
        tools/stelz_brand_watch/71_ig_posts_archive.py --event lowlands-2026
        ... --per-handle 12        # posts per creator (default 12)
        ... --since 2026-08-01     # ignore anything older
        ... --no-video             # covers and stills only

COST: apify/instagram-scraper bills PER RESULT at $0.0023 — 28 handles x 12
posts = 336 results = $0.77. Unlike the TikTok actor this one is not free, so
--per-handle is a real budget lever and the estimate is printed before the run
starts, not after.

EVERY SLIDE, NOT JUST THE FIRST. A carousel arrives as one item with
`childPosts`; taking only `displayUrl` would judge a ten-slide post by slide
one. Each child is archived as its own row with a `slot` index, which is also
how the backend persists them (scan_hashtags._persist_sidecar_child) — so the
post id keeps the two-segment shape the frontend groups on.

WHOSE PROFILE IT CAME FROM. Every row records `scraped_for`: the handle whose
profile Apify was reading when it returned this post, taken from `inputUrl`.
Instagram publishes a collab post on both authors' profiles, so 44 rows across
15 accounts that are not on the roster — @golfnl, agencies, brand accounts —
are in fact roster deliveries with a co-author. Without this field they read as
strangers, and filing them as organic reach would credit the campaign with
pickup it actually paid for.
"""
from __future__ import annotations

import argparse
import datetime as dt
import importlib.util
import json
import os
import re
import sys
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "firebase" / "functions"))

_fspec = importlib.util.spec_from_file_location(
    "_fetch", Path(__file__).with_name("_fetch.py"))
F = importlib.util.module_from_spec(_fspec)
_fspec.loader.exec_module(F)

_spec = importlib.util.spec_from_file_location(
    "_events", Path(__file__).with_name("_events.py"))
E = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(E)

# Assigned in main() from --event. See the note in 70_tiktok_archive.py.
P: "E.Paths" = None  # type: ignore[assignment]

APIFY = "https://api.apify.com/v2"
ACTOR = "apify/instagram-scraper"
COST_PER_RESULT = 0.0023
BATCH = 10   # the cap scrape_profile_ig documents; large batches time out


def token() -> str | None:
    t = os.getenv("APIFY_API_TOKEN")
    if t:
        return t
    env = ROOT / "firebase" / "functions" / ".env"
    if env.exists():
        for line in env.read_text().splitlines():
            if line.startswith("APIFY_API_TOKEN="):
                return line.split("=", 1)[1].strip()
    return None


def scrape(handles: list[str], per_handle: int, tok: str) -> list[dict]:
    urls = [f"https://www.instagram.com/{h}/" for h in handles]
    r = requests.post(
        f"{APIFY}/acts/{ACTOR.replace('/', '~')}/run-sync-get-dataset-items",
        params={"token": tok, "timeout": 300, "memory": 1024},
        json={"directUrls": urls, "resultsType": "posts", "resultsLimit": per_handle,
              "addParentData": False, "searchType": "user", "searchLimit": 1},
        timeout=330,
    )
    r.raise_for_status()
    items = r.json()
    return items if isinstance(items, list) else []


def scraped_for(item: dict) -> str | None:
    """Whose profile Apify was reading when it returned this post.

    `inputUrl` is the request, not the result: it is the profile URL this run
    asked for, and it survives on every item the actor emits. On a collab post
    it is the ONLY link back to the roster, because ownerUsername is then the
    co-author's account. All 211 archived payloads carry it.
    """
    url = item.get("inputUrl") or ""
    m = re.search(r"instagram\.com/([^/?#]+)", str(url))
    return m.group(1).strip().lower() or None if m else None


def rows_for(item: dict) -> list[dict]:
    """One post -> one row per image/video to analyse.

    A carousel yields one row per child. The id keeps the shape the frontend's
    parentPostKey expects: the slot goes in a field, never as a third
    underscore-separated segment of the id.
    """
    handle = (item.get("ownerUsername") or "").strip().lower()
    code = str(item.get("shortCode") or item.get("id") or "")
    if not handle or not code:
        return []
    base = {
        "handle": handle,
        "scraped_for": scraped_for(item),
        # Instagram's own list of co-authors, when it gives one. Kept beside
        # scraped_for rather than instead of it: this field is present on 36 of
        # 211 payloads, inputUrl on all of them.
        "coauthors": [c.get("username") for c in (item.get("coauthorProducers") or [])
                      if isinstance(c, dict) and c.get("username")],
        "short_code": code,
        "url": item.get("url") or f"https://www.instagram.com/p/{code}/",
        "posted_at": item.get("timestamp"),
        "caption": item.get("caption") or "",
        "hashtags": item.get("hashtags") or [],
        "mentions": item.get("mentions") or [],
        "likes_count": item.get("likesCount") or 0,
        "comments_count": item.get("commentsCount") or 0,
        # Reels report plays; a photo post reports nothing. Zero would read as
        # "nobody watched" for a surface that has no such number at all.
        "views_count": item.get("videoViewCount") or None,
        "full_name": item.get("ownerFullName"),
        "is_sponsored": bool(item.get("isSponsored")),
    }
    children = item.get("childPosts") or []
    out: list[dict] = []
    if children:
        for i, ch in enumerate(children):
            vurl = ch.get("videoUrl")
            out.append({**base, "item_id": f"{code}s{i}", "slot": i,
                        "slots": len(children),
                        "media_type": "video" if vurl else "image",
                        "cover_url": ch.get("displayUrl"), "video_url": vurl})
    else:
        vurl = item.get("videoUrl")
        out.append({**base, "item_id": code, "slot": 0, "slots": 1,
                    "media_type": "video" if vurl else "image",
                    "cover_url": item.get("displayUrl"), "video_url": vurl})
    return [r for r in out if r.get("cover_url") or r.get("video_url")]


def download(url: str | None, dest: Path) -> int:
    """Thin wrapper so the loop below reads unchanged. The timeouts, the
    dead-host rule and the concurrency live in _fetch, shared with 62 and 70 —
    this used to be a fourth copy with a 90-second scalar timeout, which is how
    one unreachable CDN host cost a round 25 minutes."""
    return F.download(url, dest)


def known_ids() -> set[str]:
    if not P.index.exists():
        return set()
    out = set()
    for line in P.index.read_text().splitlines():
        if line.strip():
            try:
                out.add(json.loads(line)["item_id"])
            except Exception:
                continue
    return out


def main() -> int:
    global P
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--event", default="lowlands-2026", choices=E.available(),
                    help="which event's roster and archive (default lowlands-2026)")
    ap.add_argument("--handles", nargs="+", metavar="HANDLE",
                    help="scrape these instead of the event roster")
    ap.add_argument("--per-handle", type=int, default=12)
    ap.add_argument("--since", help="ISO date; skip posts older than this")
    ap.add_argument("--no-video", action="store_true")
    args = ap.parse_args()

    tok = token()
    if not tok:
        print("APIFY_API_TOKEN not set (and not in firebase/functions/.env)")
        return 2

    ev = E.load(args.event)
    P = E.paths(ev, "ig-posts")
    handles = [h.lstrip("@").lower() for h in (args.handles or E.roster_ig(ev))]
    est = len(handles) * args.per_handle * COST_PER_RESULT
    print(f"{ev['name']} · {len(handles)} handles x {args.per_handle} posts = "
          f"{len(handles) * args.per_handle} results ≈ ${est:.2f} at Apify\n")

    P.mkdirs()

    items: list[dict] = []
    for i in range(0, len(handles), BATCH):
        batch = handles[i:i + BATCH]
        print(f"  batch {i // BATCH + 1}: {', '.join(batch)}")
        try:
            got = scrape(batch, args.per_handle, tok)
        except Exception as e:
            print(f"    ✕ {str(e)[:100]}")
            continue
        print(f"    {len(got)} posts")
        items.extend(got)

    cutoff = None
    if args.since:
        cutoff = dt.datetime.fromisoformat(args.since).replace(tzinfo=dt.timezone.utc)

    already = known_ids()
    added = skipped = old = 0
    bytes_saved = 0

    # WHICH POSTS SURVIVE THE FILTERS — decided once, here, so the warm-up below
    # and the bookkeeping loop after it cannot end up disagreeing about what
    # this run is fetching.
    planned: list[tuple[dict, list[dict]]] = []
    for item in items:
        rows = rows_for(item)
        if not rows:
            continue
        if cutoff and rows[0].get("posted_at"):
            try:
                when = dt.datetime.fromisoformat(
                    rows[0]["posted_at"].replace("Z", "+00:00"))
                if when < cutoff:
                    old += 1
                    continue
            except Exception:
                pass
        planned.append((item, rows))

    # CONCURRENT WARM-UP. Every file the loop below is about to ask for, pulled
    # six at a time instead of one. It changes nothing about the loop: download()
    # returns immediately for a file already on disk, so the order, the counters
    # and the index writes stay exactly as they were — this only stops the round
    # standing still while one CDN thinks about it.
    jobs = []
    for _, rows in planned:
        for e in rows:
            if e["item_id"] in already:
                continue
            iid = e["item_id"]
            jobs.append((e["cover_url"], P.media / f"{iid}.jpg"))
            if e["media_type"] == "video" and not args.no_video:
                jobs.append((e["video_url"], P.media / f"{iid}.mp4",
                             F.VIDEO_READ_TIMEOUT))
    if jobs:
        print(f"\n  {len(jobs)} bestanden ophalen, {F.PREFETCH_WORKERS} tegelijk")
        F.prefetch(jobs)

    with P.index.open("a") as idx:
        for item, rows in planned:
            code = rows[0]["short_code"]
            (P.raw / f"{code}.json").write_text(json.dumps(item, indent=1))
            for e in rows:
                if e["item_id"] in already:
                    skipped += 1
                    continue
                iid = e["item_id"]
                e["raw_file"] = f"{code}.json"
                e["event"] = ev["id"]
                e["image_file"] = None
                n = download(e["cover_url"], P.media / f"{iid}.jpg")
                if n:
                    e["image_file"] = f"{iid}.jpg"
                    bytes_saved += n
                e["video_file"] = None
                e["video_unavailable"] = False
                if e["media_type"] == "video" and not args.no_video:
                    n = download(e["video_url"], P.media / f"{iid}.mp4")
                    if n:
                        e["video_file"] = f"{iid}.mp4"
                        bytes_saved += n
                    else:
                        e["video_unavailable"] = True
                if not e["image_file"] and not e["video_file"]:
                    continue
                idx.write(json.dumps(e) + "\n")
                already.add(iid)
                added += 1

    print(f"\n  +{added} new · {skipped} already archived · {old} older than --since")
    print(f"  +{bytes_saved / 1e6:.1f} MB · {len(known_ids())} in {P.label()}")
    print(f"  Apify: {len(items)} results ≈ ${len(items) * COST_PER_RESULT:.2f}")
    print(f"\n  Next: 74_analyse.py --event {ev['id']} --archive ig-posts --max-dim 0")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
