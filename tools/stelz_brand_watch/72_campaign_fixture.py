#!/usr/bin/env python3
"""Merge an event's archives into one campaign fixture for the dev server.

    ./firebase/functions/venv/bin/python \\
        tools/stelz_brand_watch/72_campaign_fixture.py --event lowlands-2026

Reads .tmp/events/<event>/{stories,ig-posts,tiktok,discovery} — index +
verdicts — and writes two files:

    preview-campaign.json             CampaignItem[]   (lib/campaign.ts)
    preview-campaign-detections.json  DetectionRow[]   (lib/types.ts)

TWO FILES, NOT ONE JOINED LIST. Production reads posts and detections from two
Firestore collections and joins them in the browser; emitting a pre-joined list
here would exercise a code path that does not exist in production and would
hide the join bug class entirely — which is exactly the bug that shipped once
already (the page passed an empty detection array and every analysed item read
as "nog niet geanalyseerd").

Written to .tmp/, never to web/public: everything in public/ is copied into
dist/ and published by `firebase deploy --only hosting`, and these files hold
scraped content and signed CDN URLs. The dev server reaches them through the
serve-only middleware in web/vite.config.ts.

Media is served from the archives at /preview-media/<archive>/<file>, so the
page shows the exact bytes the analysis read rather than a re-fetched CDN copy
that may already have expired.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path


def _write_atomic(path: Path, text: str) -> None:
    """tmp + rename. De dev-server streamt deze bestanden terwijl wij ze
    herbouwen; een afgekapte 200 rendert als "Nog geen data" over een vol
    archief. os.replace is atomair op hetzelfde filesystem."""
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text)
    os.replace(tmp, path)

ROOT = Path(__file__).resolve().parents[2]
TMP = ROOT / ".tmp"
OUT_ITEMS = TMP / "preview-campaign.json"
OUT_DETS = TMP / "preview-campaign-detections.json"

_espec = importlib.util.spec_from_file_location(
    "_events", Path(__file__).with_name("_events.py"))
E = importlib.util.module_from_spec(_espec)
_espec.loader.exec_module(E)

# (archive kind, id field, default surface, default platform)
#
# Note what is NOT in this table any more: `source`. It used to be a property of
# the ARCHIVE — everything in the discovery archive was organic, everything in
# the roster archives was paid. That is wrong in both directions. A hashtag
# search returns roster creators, and a roster profile scrape returns collab
# posts published from a co-author's account: 44 rows across 15 accounts that
# are not on the roster and are not strangers either. Source is a property of
# the ACCOUNT, so it is decided per row, from the roster.
KINDS = [
    ("stories", "story_id", "story", "instagram"),
    ("ig-posts", "item_id", "post", "instagram"),
    ("tiktok", "video_id", "tiktok", "tiktok"),
    ("discovery", "video_id", "tiktok", "tiktok"),
]


def read_jsonl(path: Path, key: str) -> dict[str, dict]:
    out: dict[str, dict] = {}
    if not path.exists():
        return out
    for line in path.read_text().splitlines():
        if line.strip():
            try:
                row = json.loads(line)
            except Exception:
                continue
            k = row.get(key) or row.get("item_id") or row.get("story_id")
            if k:
                out[str(k)] = row
    return out


def media_url(event_id: str, kind: str, filename: str | None) -> str | None:
    """Where the dev server serves the archived bytes from.

    Per event and per kind, matching the directory layout. web/vite.config.ts
    validates both segments against an allow-list before joining them onto a
    path — this string is a URL a browser asks for, not a trusted value."""
    return f"/preview-media/{event_id}/{kind}/{filename}" if filename else None


def item_id(surface: str, raw_id: str) -> str:
    """The id the frontend joins on.

    No extra underscore-separated segment: lib/types.parentPostKey groups by the
    first TWO segments of a post id, so "instagram_story_123" parses as post
    "story" and every story collapses into one row. That bug shipped once; the
    shape is load-bearing, not cosmetic.
    """
    return {"story": f"instagram_story{raw_id}",
            "post": f"instagram_post{raw_id}",
            "tiktok": f"tiktok_video{raw_id}"}[surface]


def source_of(e: dict, roster: set[str]) -> str:
    """Paid or organic, decided by the account rather than by the archive.

    Both handles are checked. `scraped_for` is the profile Apify was reading
    when it returned the post, which on a collab post is the ONLY link back to
    the roster — ownerUsername is then the co-author's account. Getting this
    wrong moves bought reach into the organic column, which is the flattering
    direction and therefore the one to guard.
    """
    for h in ((e.get("handle") or ""), (e.get("scraped_for") or "")):
        if h.strip().lstrip("@").lower() in roster:
            return "roster"
    for c in (e.get("coauthors") or []):
        if str(c).strip().lstrip("@").lower() in roster:
            return "roster"
    return "discovery"


def person(e: dict, ids: dict[str, str], roster: set[str], source: str) -> str:
    """The PERSON this content should be credited to.

    Three cases, in order:

      1. A TikTok handle the roster knows -> that person's Instagram handle.
         Rein is @rvdofficial on Instagram and @rinnavandoffoe on TikTok; keyed
         on the account he is two creators and a roster of 28 reports 30.
      2. A collab post -> whoever's profile it was found on. Instagram
         publishes it under the co-author's account, so @golfnl, @bnnvara and
         thirteen others show up as creators nobody booked. They are Britt
         Messing's post and Jitske Schaap's post.
      3. Anything else -> the account, unchanged.

    Only for roster content. A discovery hit stays credited to whoever posted
    it — that is the whole point of the organic column.
    """
    handle = (e.get("handle") or "").strip().lower()
    if handle in ids:
        return ids[handle]
    if source == "roster" and handle not in roster:
        for candidate in [(e.get("scraped_for") or ""), *(e.get("coauthors") or [])]:
            c = str(candidate).strip().lstrip("@").lower()
            if c in roster:
                return ids.get(c, c)
    return handle


def resolve_surface(e: dict, surface: str, platform: str) -> tuple[str, str]:
    """What this row actually is, as opposed to what its archive mostly holds.

    A brand hashtag search returns Instagram posts into an archive that is
    otherwise TikTok, and the row records its own platform. Resolved ONCE and
    handed to both builders: to_item and to_detection each derive the joining
    id from the surface, so a surface decided twice is a post id that does not
    match its own detection. Three Instagram discovery rows shipped exactly
    that — "tiktok_videoigDcOwPojMxIM" against "instagram_postigDcOwPojMxIM" —
    and the page reads an unjoined detection as "nog niet geanalyseerd".
    """
    platform = e.get("platform") or platform
    if platform == "instagram" and surface == "tiktok":
        surface = "post"
    return surface, platform


def to_item(e: dict, v: dict | None, event_id: str, kind: str, surface: str,
            platform: str, ids: dict[str, str], roster: set[str], source: str) -> dict:
    raw_id = str(e.get("story_id") or e.get("item_id") or e.get("video_id"))
    is_video = bool(e.get("video_file")) or e.get("media_type") == "video"
    handle = (e.get("handle") or "").lower()
    return {
        "itemId": item_id(surface, raw_id),
        "eventId": event_id,
        "source": source,
        "foundVia": e.get("found_via"),
        # Whose profile this was found on. Kept on the row so lib/events
        # matchEvent can reach the same verdict in the browser instead of
        # trusting a label baked in here.
        "scrapedFor": (e.get("scraped_for") or "").lower() or None,
        # A carousel is one post shown as several rows. The shortcode is what
        # says which rows are the same post, so "18 posts · 37 beelden" can be
        # counted instead of reporting 37 posts.
        "postKey": e.get("short_code") or raw_id,
        "slot": e.get("slot"),
        "slots": e.get("slots"),
        "platform": platform,
        "surface": surface,
        # The PERSON, not the account. See identity_map.
        "creatorHandle": person(e, ids, roster, source),
        "platformHandle": handle,
        "url": e.get("url") or (
            f"https://www.instagram.com/stories/{e.get('handle')}/{raw_id}/"
            if surface == "story" else None),
        "coverUrl": media_url(event_id, kind, e.get("image_file")),
        "videoUrl": media_url(event_id, kind, e.get("video_file")),
        "mediaType": "video" if is_video else "image",
        "postedAt": e.get("posted_at"),
        "caption": e.get("caption") or None,
        "hashtags": e.get("hashtags") or [],
        "mentions": e.get("mentions") or [],
        "videoDuration": e.get("duration"),
        # None, not 0, where the surface publishes no such figure. A story has
        # no view count in existence; a photo post has no play count. Zero would
        # read as "nobody watched", which is a claim, not a blank.
        "views": e.get("play_count") if surface == "tiktok" else e.get("views_count"),
        "likes": e.get("digg_count") if surface == "tiktok" else e.get("likes_count"),
        "comments": e.get("comment_count") if surface == "tiktok" else e.get("comments_count"),
        "shares": e.get("share_count") if surface == "tiktok" else None,
        # Saves. TikTok's strongest intent signal — a like costs nothing and a
        # save means "I want this back" — and it has been in the archive since
        # the first harvest without ever reaching a screen. Instagram publishes
        # no equivalent, so it is None there rather than 0.
        "saves": e.get("collect_count") if surface == "tiktok" else None,
        "pollVotes": e.get("poll_votes") if surface == "story" else None,
        "isPaidPartnership": bool(e.get("is_ad") or e.get("is_sponsored")
                                  or e.get("is_paid_partnership")),
    }


def to_detection(e: dict, v: dict, event_id: str, kind: str, surface: str,
                 platform: str, ids: dict[str, str], roster: set[str],
                 source: str) -> dict:
    raw_id = str(e.get("story_id") or e.get("item_id") or e.get("video_id"))
    return {
        "detection_id": f"preview_{surface}_{raw_id}",
        "creator_id": None,
        "creator_handle": person(e, ids, roster, source),
        "creator_category": None,
        "platform": platform,
        "product_line": v.get("product_line"),
        "confidence": v.get("confidence"),
        "size_in_frame": v.get("size_in_frame"),
        "is_primary_subject": v.get("is_primary_subject"),
        "image_url": media_url(event_id, kind, e.get("image_file")),
        "stored_path": None,
        "post_url": e.get("url"),
        "post_caption": e.get("caption") or None,
        "posted_at": e.get("posted_at"),
        "likes_count": None, "comments_count": None, "views_count": None,
        "follower_count": e.get("follower_count"),
        "creator_tier": "tier_2",
        "verified": e.get("verified"),
        "context": v.get("context"),
        "post_hashtags": e.get("hashtags") or [],
        "post_mentions": e.get("mentions") or [],
        "music": None,
        "extras": None,
        "content_type": "story" if surface == "story" else "video",
        "expires_at": e.get("expires_at"),
        "frame_idx": None,
        "frames_judged": v.get("frames_judged"),
        "near_miss": bool(v.get("near_miss")),
        "near_miss_reason": v.get("near_miss_reason"),
        "cover_only": bool(v.get("cover_only")),
        "post_id": item_id(surface, raw_id),
        "surface_type": v.get("surface_type"),
        "visible_text": v.get("visible_text"),
        "false_positive_risk": v.get("false_positive_risk"),
        "people_count": v.get("people_count"),
        "setting": v.get("setting"),
        "activity": v.get("activity"),
        "gate": v.get("gate"),
        "verify_verdict": v.get("verify_verdict"),
        "verify_brand": v.get("verify_brand"),
        "verify_reason": v.get("verify_reason"),
        # Signage / merchandise / clothing, when the wordmark was not on a can.
        "verify_placement": v.get("verify_placement"),
        # The resolution this verdict was reached at, and whether the DEPLOYED
        # function — which downscales every image to 512px — still finds it.
        # False here means the dashboard is showing a sighting the live backend
        # would currently miss, which is a fact about the deploy, not about the
        # photo, and belongs on screen rather than in a note somewhere.
        "max_dim": v.get("max_dim"),
        "found_at_prod_res": v.get("found_at_prod_res"),
        "sentiment": None, "sentiment_score": None, "sentiment_rationale": None,
        "brand_id": "stelz",
        "detected": bool(v.get("detected")),
        "is_false_positive": None,
    }


def content_key(e: dict, surf: str, kind: str, raw_id: str) -> tuple:
    """What makes two archive rows the SAME image or video.

    Production keys a post document on its platform id, so the same clip found
    twice — once via #stelz, once via the profile scrape of its poster — is one
    document there and must be one row here. The archives cannot promise that:
    70/71/73 each dedupe against their own index only, and the id TEXT differs
    across them (discovery prefixes IG ids with "ig"), so identity comes from
    the archive FIELDS, never from string surgery on ids.

    A carousel slide is matched per slide: the can on slide 3 and the can on
    slide 7 are two sightings of one post, and stay two rows. Stories are never
    merged — only one archive holds them.
    """
    handle = (e.get("handle") or "").lower()
    if surf == "tiktok":
        return ("tt", handle, str(e.get("video_id") or raw_id))
    if surf == "post" and e.get("short_code"):
        return ("ig", handle, e["short_code"], e.get("slot"))
    return ("uniq", kind, raw_id)


# Filled from a duplicate onto its survivor when the survivor has None. The two
# copies split the truth between them: the profile scrape carries the metrics,
# the tag scrape carries found_via — merging must lose neither.
FILL_FIELDS = (
    "play_count", "digg_count", "comment_count", "share_count", "collect_count",
    "likes_count", "comments_count", "views_count", "follower_count",
    "scraped_for", "posted_at", "caption", "duration", "url",
)


def merge_group(grp: list[dict], kind_rank: dict[str, int]) -> dict:
    """One candidate out of several archive copies of the same content.

    Survivor: the copy whose verdict says Stëlz, else any judged copy, else
    KINDS order — so a sighting is never traded for an unjudged twin. Grafted
    onto it: found_via and the caption-hashtag union (both feed the account-
    evidence rule in lib/events — dropping them would silently un-count every
    untagged post that rode on this account's proof), plus any metric the
    survivor is missing.
    """
    def rank(c: dict) -> tuple:
        v = c["v"]
        return (0 if (v and v.get("detected")) else 1 if v else 2,
                kind_rank[c["kind"]])
    survivor = min(grp, key=rank)
    e = dict(survivor["e"])
    for other in grp:
        if other is survivor:
            continue
        oe = other["e"]
        if not e.get("found_via") and oe.get("found_via"):
            e["found_via"] = oe["found_via"]
        have = {str(t).lower() for t in (e.get("hashtags") or [])}
        extra = [t for t in (oe.get("hashtags") or []) if str(t).lower() not in have]
        if extra:
            e["hashtags"] = list(e.get("hashtags") or []) + extra
        for f in FILL_FIELDS:
            if e.get(f) is None and oe.get(f) is not None:
                e[f] = oe[f]
    return {**survivor, "e": e}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--event", default="lowlands-2026", choices=E.available())
    args = ap.parse_args()

    ev = E.load(args.event)
    ids = E.identity_map(ev)
    roster = E.roster_accounts(ev)
    items: list[dict] = []
    dets: list[dict] = []
    report: list[str] = []

    # PASS 1 — read every archive, resolve per row, group by content identity.
    kind_rank = {kind: i for i, (kind, *_rest) in enumerate(KINDS)}
    groups: dict[tuple, list[dict]] = {}
    order: list[tuple] = []
    for kind, id_field, surface, platform in KINDS:
        P = E.paths(ev, kind)
        index = read_jsonl(P.index, id_field)
        verdicts = read_jsonl(P.dir / "verdicts.jsonl", "item_id")
        hits = near = 0
        for raw_id, e in index.items():
            v = verdicts.get(raw_id)
            surf, plat = resolve_surface(e, surface, platform)
            key = content_key(e, surf, kind, raw_id)
            if key not in groups:
                groups[key] = []
                order.append(key)
            groups[key].append({"kind": kind, "raw_id": raw_id, "e": e, "v": v,
                                "surf": surf, "plat": plat})
            if v is not None:
                hits += bool(v.get("detected"))
                near += bool(v.get("near_miss"))
        report.append(f"  {kind:<10} {len(index):>4} rijen · {len(verdicts):>4} beoordeeld · "
                      f"{hits} met Stëlz · {near} bijna")

    # PASS 2 — one row per piece of content, however many archives hold it.
    merged_away = 0
    for key in order:
        grp = groups[key]
        c = merge_group(grp, kind_rank) if len(grp) > 1 else grp[0]
        merged_away += len(grp) - 1
        src = source_of(c["e"], roster)
        items.append(to_item(c["e"], c["v"], ev["id"], c["kind"], c["surf"],
                             c["plat"], ids, roster, src))
        # Only judged items get a detection row. An absent row is what makes
        # the UI say "nog niet geanalyseerd" instead of inventing a miss.
        if c["v"] is not None:
            dets.append(to_detection(c["e"], c["v"], ev["id"], c["kind"],
                                     c["surf"], c["plat"], ids, roster, src))
    if merged_away:
        report.append(f"  {merged_away} beelden stonden in meer dan één archief — "
                      "samengevoegd, tag en cijfers behouden")

    if not items:
        print(f"No archives under {E.paths(ev, 'stories').dir.parent} — harvest first "
              "(62_stories_archive.py, 70, 71, 73)")
        return 1

    _write_atomic(OUT_ITEMS, json.dumps(items, indent=1))
    _write_atomic(OUT_DETS, json.dumps(dets, indent=1))

    print(f"{ev['name']} · {ev['venue']}")
    print("\n".join(report))

    # ---- what actually falls inside the event -------------------------------
    # Everything above counts the ARCHIVE, which reaches back years. These
    # numbers count the EVENT. Printing only the first set is how a festival
    # page came to report 50 sightings for a weekend that had 8.
    start, end = E.window(ev)
    judged = {d["post_id"] for d in dets}
    hit_ids = {d["post_id"] for d in dets if d.get("detected")}
    inside = [i for i in items if E.in_window(ev, i.get("postedAt"))]

    def posts(rows: list[dict]) -> int:
        """Unique posts, not rows. A ten-slide carousel is one post."""
        return len({(r["platformHandle"], r["postKey"]) for r in rows})

    for src in ("roster", "discovery"):
        rows = [i for i in inside if i["source"] == src]
        seen = [r for r in rows if r["itemId"] in judged]
        hit = [r for r in rows if r["itemId"] in hit_ids]
        views = sum(r["views"] or 0 for r in rows if r["surface"] == "tiktok")
        label = "roster   " if src == "roster" else "los      "
        print(f"\n  {label} {posts(rows)} posts ({len(rows)} beelden) · "
              f"{len(seen)} beoordeeld · {posts(hit)} met Stëlz")
        print(f"            {len({r['platformHandle'] for r in rows if r['platformHandle']})} "
              f"accounts · {views:,} TikTok-weergaven")

    print(f"\n  venster {start} t/m {end}: {len(inside)} van {len(items)} beelden")
    print(f"  {len(items) - len(inside)} beelden vallen erbuiten — ouder of nieuwer dan "
          f"het evenement, en dus geen {ev['name']}")
    print(f"\n  wrote {OUT_ITEMS.relative_to(ROOT)}")
    print(f"        {OUT_DETS.relative_to(ROOT)}")
    print(f"\n  open http://localhost:5173/evenementen/{ev['id']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
