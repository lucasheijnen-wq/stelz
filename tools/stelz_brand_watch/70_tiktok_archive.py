#!/usr/bin/env python3
"""Archive the roster's TikToks locally: covers, videos and the raw payloads.

The Lowlands roster has always carried TikTok handles next to the Instagram
ones — 25 of the 28 people have one — and nothing has ever scraped them. The
backend can already do it (handlers/scan_creators.py splits handles by platform
and calls the same actor), it has simply never been run, and it cannot be run
here because the Cloud Functions are not deployed.

    ./firebase/functions/venv/bin/python \\
        tools/stelz_brand_watch/70_tiktok_archive.py --event lowlands-2026
        ... --handles stefandevries joshbram_        # a couple by hand
        ... --per-handle 30                          # how deep (default 12)
        ... --no-video                               # covers only, faster

ON --per-handle: the default of 12 is a profile depth, not a date range. Every
handle in the first archive had exactly 12 videos, which looked like a roster
fact and was the flag value. For a festival, ask for more than the creator is
likely to have posted since it started.

WHAT IT COSTS: nothing at Apify. `clockworks/free-tiktok-scraper` is priced at
$0.0000 per result in BOTH cost tables (lib/usage.COST_PER_UNIT and
web/src/lib/costs.ts), one run per handle. Only the analysis afterwards costs
money, and that is 74_tiktok_analyse.py's bill, not this script's.

WHY THE VIDEOS AND NOT JUST THE COVERS: a TikTok cover is a single chosen frame,
usually the most flattering one, and a can appears when someone drinks from it
— not when they pose. tools/stelz_brand_watch/48_tiktok_profile_scan.py (the
old Supabase-era script) analysed covers only and said so: "Will revisit when
TikTok hit rate climbs". Judging a 30-second clip by its thumbnail is how a
brand-visibility tool reports zero forever.

Idempotent on video id. A second run adds only what is new, and a video whose
download failed is retried next time rather than recorded as analysed.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import tempfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import importlib.util

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

# Assigned once, in main(), from --event. Not a module-level constant: an
# archive path that is fixed at import time says an event is a singleton, which
# is the assumption this whole change exists to remove.
P: "E.Paths" = None  # type: ignore[assignment]

APIFY = "https://api.apify.com/v2"
ACTOR = "clockworks/free-tiktok-scraper"


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


def scrape(handle: str, per_handle: int, tok: str) -> list[dict]:
    """One actor run per handle — the shape scan_creators.py uses. Clockworks
    takes a single profile per run, so this is a run count, not a batch size."""
    try:
        r = requests.post(
            f"{APIFY}/acts/{ACTOR.replace('/', '~')}/run-sync-get-dataset-items",
            params={"token": tok, "timeout": 300, "memory": 1024},
            json={"profiles": [handle], "resultsPerPage": per_handle,
                  "shouldDownloadVideos": False, "shouldDownloadCovers": False},
            timeout=330,
        )
        r.raise_for_status()
        items = r.json()
        return items if isinstance(items, list) else []
    except Exception as e:
        print(f"  ✕ @{handle}: {str(e)[:90]}")
        return []


def normalise(item: dict, fallback_handle: str) -> dict | None:
    """Clockworks item -> the fields the archive and the analysis need.

    Field names mirror handlers/scan_creators.py's tiktok branch exactly, so a
    payload change breaks both in the same place instead of only here.
    """
    vid = str(item.get("id") or item.get("aweme_id") or "")
    if not vid:
        return None
    author = item.get("authorMeta") or {}
    handle = (author.get("name") or author.get("uniqueId") or fallback_handle or "").lower()
    vmeta = item.get("videoMeta") or {}
    mm = item.get("musicMeta") or {}
    posted = item.get("createTimeISO")
    if not posted and item.get("createTime"):
        try:
            posted = dt.datetime.fromtimestamp(
                int(item["createTime"]), dt.timezone.utc).isoformat()
        except Exception:
            posted = None
    return {
        "video_id": vid,
        "handle": handle,
        "url": item.get("webVideoUrl") or item.get("shareUrl"),
        "posted_at": posted,
        "caption": item.get("text") or item.get("desc") or "",
        "hashtags": [h.get("name") for h in (item.get("hashtags") or []) if h.get("name")],
        "mentions": [m for m in (item.get("mentions") or []) if isinstance(m, str)],
        "cover_url": vmeta.get("coverUrl") or vmeta.get("originalCoverUrl"),
        # downloadAddr is watermark-free and short-lived; webVideoUrl is the
        # page, which yt-dlp resolves. Both are kept so the download can fall
        # back rather than give up.
        "download_url": vmeta.get("downloadAddr") or item.get("downloadAddr"),
        "duration": vmeta.get("duration"),
        # The only real viewing figures anywhere in this product. Instagram
        # gives story views to the account owner alone; TikTok publishes them.
        "play_count": item.get("playCount") or 0,
        "digg_count": item.get("diggCount") or 0,
        "comment_count": item.get("commentCount") or 0,
        "share_count": item.get("shareCount") or 0,
        "collect_count": item.get("collectCount") or 0,
        "follower_count": author.get("fans"),
        "full_name": author.get("nickName"),
        "avatar_url": author.get("avatar"),
        "verified": bool(author.get("verified")),
        "is_ad": bool(item.get("isAd") or item.get("isSponsored")),
        "is_slideshow": bool(item.get("isSlideshow")),
        # What language the caption is in, as TikTok detected it. The audience
        # question a Dutch brand actually has is "is this crowd Dutch", and this
        # is the only field in either platform's payload that answers it — no
        # location, no region, no age. None rather than "" when absent, because
        # "unknown language" and "no language" are different things.
        "text_language": item.get("textLanguage") or None,
        "music": {"title": mm.get("musicName"), "artist": mm.get("musicAuthor"),
                  "original": bool(mm.get("musicOriginal"))} if mm else None,
    }


def download(url: str | None, dest: Path) -> int:
    """Also 73's downloader — it imports this module rather than keeping a
    second opinion. Timeouts and the dead-host rule live in _fetch."""
    return F.download(url, dest)


def download_video(entry: dict, dest: Path) -> int:
    """downloadAddr first, yt-dlp on the page URL second.

    TikTok throttles both, so a failure here is expected rather than
    exceptional. The caller records `video_unavailable` and the analysis then
    judges the cover ALONE and says so — the one thing that must never happen
    is a cover-only verdict presented as if the whole clip was watched.
    """
    if dest.exists() and dest.stat().st_size > 0:
        return dest.stat().st_size
    direct = entry.get("download_url")
    if direct:
        # min_bytes: a throttled TikTok answers with a short error page and a
        # 200, so "it downloaded" is not the same as "it is a video".
        n = F.download(direct, dest, read_timeout=F.VIDEO_READ_TIMEOUT,
                       min_bytes=10_000, quiet=True)
        if n:
            return n
    page = entry.get("url")
    if not page:
        return 0
    try:
        import yt_dlp
    except Exception:
        return 0
    with tempfile.TemporaryDirectory() as tmp:
        out = os.path.join(tmp, "v.%(ext)s")
        try:
            with yt_dlp.YoutubeDL({
                "outtmpl": out,
                "format": "best[ext=mp4][filesize<25M]/best[ext=mp4]/best",
                "quiet": True, "no_warnings": True, "noprogress": True,
                "socket_timeout": 30,
            }) as ydl:
                ydl.download([page])
        except Exception as e:
            print(f"    ✕ video {dest.name}: {str(e)[:70]}")
            return 0
        got = [Path(tmp) / f for f in os.listdir(tmp)]
        if not got:
            return 0
        data = got[0].read_bytes()
        dest.write_bytes(data)
        return len(data)


def known_ids() -> set[str]:
    if not P.index.exists():
        return set()
    out = set()
    for line in P.index.read_text().splitlines():
        if line.strip():
            try:
                out.add(json.loads(line)["video_id"])
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
    ap.add_argument("--no-video", action="store_true", help="archive covers only")
    ap.add_argument("--concurrency", type=int, default=5)
    args = ap.parse_args()

    tok = token()
    if not tok:
        print("APIFY_API_TOKEN not set (and not in firebase/functions/.env)")
        return 2

    ev = E.load(args.event)
    P = E.paths(ev, "tiktok")
    handles = args.handles or E.roster_tt(ev)
    handles = [h.lstrip("@").lower() for h in handles]
    print(f"{ev['name']} · {len(handles)} TikTok handles · "
          f"{args.per_handle} most recent each")
    print(f"Apify: {ACTOR} — $0.00 per result, {len(handles)} runs\n")

    P.mkdirs()

    all_items: list[tuple[str, dict]] = []
    with ThreadPoolExecutor(max_workers=args.concurrency) as ex:
        futures = {ex.submit(scrape, h, args.per_handle, tok): h for h in handles}
        for fut in as_completed(futures):
            h = futures[fut]
            items = fut.result()
            print(f"  @{h}: {len(items)} videos")
            all_items.extend((h, it) for it in items)

    already = known_ids()
    added = skipped = no_video = 0
    bytes_saved = 0
    with P.index.open("a") as idx:
        for fallback, item in all_items:
            e = normalise(item, fallback)
            if e is None:
                continue
            if e["video_id"] in already:
                skipped += 1
                continue
            vid = e["video_id"]
            (P.raw / f"{vid}.json").write_text(json.dumps(item, indent=1))
            e["raw_file"] = f"{vid}.json"
            # Which event this row belongs to, written where the analyser and
            # the fixture builder both read it. Attribution is still DERIVED on
            # the client (lib/events.matchEvent) — this is provenance: which
            # event's harvest paid for this row.
            e["event"] = ev["id"]

            e["image_file"] = None
            if e["cover_url"]:
                n = download(e["cover_url"], P.media / f"{vid}.jpg")
                if n:
                    e["image_file"] = f"{vid}.jpg"
                    bytes_saved += n

            e["video_file"] = None
            e["video_unavailable"] = False
            if not args.no_video and not e["is_slideshow"]:
                n = download_video(e, P.media / f"{vid}.mp4")
                if n:
                    e["video_file"] = f"{vid}.mp4"
                    bytes_saved += n
                else:
                    e["video_unavailable"] = True
                    no_video += 1

            if not e["image_file"] and not e["video_file"]:
                # Nothing to look at. Recording it would create a row that can
                # never be analysed and would sit in the UI as a permanent
                # "nog niet geanalyseerd".
                continue
            idx.write(json.dumps(e) + "\n")
            already.add(vid)
            added += 1

    total = len(known_ids())
    print(f"\n  +{added} new · {skipped} already archived · {total} in {P.label()}")
    print(f"  +{bytes_saved / 1e6:.1f} MB")
    if no_video:
        print(f"  {no_video} video{'' if no_video == 1 else 's'} could not be downloaded "
              f"(TikTok throttling) — cover archived, marked video_unavailable")
    print(f"\n  Next: 74_analyse.py --event {ev['id']} --archive tiktok --max-dim 0")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
