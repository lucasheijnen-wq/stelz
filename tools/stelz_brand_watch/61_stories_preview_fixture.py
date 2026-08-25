#!/usr/bin/env python3
"""Turn the LAST stories actor run into a local UI preview fixture.

Why this exists: the stories UI cannot be seen working until scan_stories is
deployed, and deploying needs credentials this machine does not have. This
closes that gap without waiting and without spending again — it re-reads the
dataset the previous run already produced, which is a free API read, and emits
the rows in the shape the frontend expects.

It starts NO actor run. If you want fresh stories, run 60_stories_smoke_test.py
first (that one costs money) and then run this.

    ./firebase/functions/venv/bin/python \\
        tools/stelz_brand_watch/61_stories_preview_fixture.py

Writes .tmp/stories-archive/preview-stories.json, which the dev server serves
at /preview-stories.json for `?preview=stories` via a serve-only Vite
middleware. Deliberately outside web/public: public/ is copied into dist/ and
deployed, and this file holds scraped Instagram data and signed CDN URLs.

Note what this proves and what it does not. It exercises the real
_normalize_item, the real expiry maths and the real rendering path. It does NOT
exercise the Firestore write or the Gemini detect fan-out.

Verdicts come from .tmp/stories-archive/verdicts.jsonl when 64_stories_analyse.py
has run; a story with no verdict gets no detection row at all, so the UI shows it
as "nog niet geanalyseerd" instead of as a miss nobody looked for.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import importlib.util
import sys
from pathlib import Path


def _write_atomic(path: Path, text: str) -> None:
    """tmp + rename. De dev-server streamt deze bestanden terwijl wij ze
    herbouwen; een afgekapte 200 rendert als "Nog geen data" over een vol
    archief. os.replace is atomair op hetzelfde filesystem."""
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text)
    os.replace(tmp, path)

import requests

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "firebase" / "functions"))
from handlers.scan_stories import STORIES_ACTOR, STORY_TTL_HOURS, _normalize_item  # noqa: E402

_espec = importlib.util.spec_from_file_location(
    "_events", Path(__file__).with_name("_events.py"))
E = importlib.util.module_from_spec(_espec)
_espec.loader.exec_module(E)

# The stories archive of the one event this fixture previews. A module-level
# path again — but derived from the event definition, so it moves when the
# event's archive moves instead of silently pointing at an empty directory.
EVENT = E.load("lowlands-2026")
ARCHIVE = E.archive_dir(EVENT, "stories")
VERDICTS = ARCHIVE / "verdicts.jsonl"
INDEX = ARCHIVE / "index.jsonl"
MEDIA = ARCHIVE / "media"
RAW = ARCHIVE / "raw"
# NOT web/public: everything in public/ is copied into dist/, so a fixture
# there is published by `vite build && firebase deploy --only hosting`. These
# hold scraped Instagram data and signed CDN URLs. The dev server reaches them
# through a serve-only middleware in web/vite.config.ts instead.
OUT = ARCHIVE / "preview-stories.json"          # DetectionRow[] — the strip
OUT_POSTS = ARCHIVE / "preview-story-posts.json"  # StoryPost[] — the /stories page
APIFY = "https://api.apify.com/v2"


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


def last_dataset_items(actor: str, tok: str) -> list[dict]:
    """Items from the most recent finished run. Free — no run is started."""
    runs = requests.get(
        f"{APIFY}/acts/{actor.replace('/', '~')}/runs",
        params={"token": tok, "limit": 1, "desc": "true"},
        timeout=60,
    )
    runs.raise_for_status()
    items = runs.json().get("data", {}).get("items", [])
    if not items:
        return []
    run = items[0]
    print(f"  run {run.get('id')} · {run.get('status')} · started {run.get('startedAt')}")
    ds = run.get("defaultDatasetId")
    if not ds:
        return []
    out = requests.get(f"{APIFY}/datasets/{ds}/items", params={"token": tok}, timeout=120)
    out.raise_for_status()
    return out.json()


def load_archive() -> dict[str, dict]:
    """Archived media, keyed by story id (62_stories_archive.py)."""
    if not INDEX.exists():
        return {}
    out: dict[str, dict] = {}
    for line in INDEX.read_text().splitlines():
        if line.strip():
            try:
                e = json.loads(line)
                out[e["story_id"]] = e
            except Exception:
                continue
    return out


def have_media() -> bool:
    """Can the dev server serve the archived files at /preview-media/<event>/stories/<file>?

    Two reasons to prefer them, and the second matters more. Instagram's story
    URLs are signed and expire within hours, so a fixture built on them is a
    page of broken images by tomorrow. And the archived bytes are the exact
    bytes the model judged — showing a re-fetched CDN copy next to a verdict
    invites the two to drift apart.

    The route is a dev-server middleware in web/vite.config.ts, NOT a symlink
    under public/: `vite build` copies public/ into dist/ and follows symlinks,
    which would push 118 MB of other people's photographs into the deployed
    bundle. Nothing here writes into the web directory at all.
    """
    return MEDIA.is_dir() and any(MEDIA.iterdir())


def load_verdicts() -> dict[str, dict]:
    """Local analysis results, keyed by story id (64_stories_analyse.py).

    Absent is not "no Stëlz" — it means nothing has judged that story yet, and
    the UI renders it as such. Writing detected=false for an unjudged story
    would report a miss we never looked for.
    """
    if not VERDICTS.exists():
        return {}
    out: dict[str, dict] = {}
    for line in VERDICTS.read_text().splitlines():
        if line.strip():
            try:
                v = json.loads(line)
                out[v["story_id"]] = v
            except Exception:
                continue
    return out


def resolve_media(norm: dict, arch: dict | None, local: bool) -> tuple[str | None, str | None]:
    """Archived file first, signed CDN URL second. The archive is permanent and
    is what the analysis actually read; the CDN link is a few hours from
    expiring and is only a fallback for a story that was never archived."""
    img, vid = norm["image_url"], norm["video_url"]
    if local and arch:
        if arch.get("image_file"):
            img = f"/preview-media/{EVENT['id']}/stories/{arch['image_file']}"
        if arch.get("video_file"):
            vid = f"/preview-media/{EVENT['id']}/stories/{arch['video_file']}"
    return img, vid


def to_row(norm: dict, idx: int, verdict: dict | None, image_url: str | None) -> dict:
    """One normalized story -> one DetectionRow, matching lib/types.ts.

    Every field the type declares is present. A row missing a key the UI reads
    optionally is fine; a row missing one it reads unconditionally crashes the
    page, and a preview that crashes teaches you nothing.
    """
    posted = norm["posted_at"] or dt.datetime.now(dt.timezone.utc)
    # Same precedence as the handler: Instagram's stated expiry first.
    expires = norm.get("expires_at") or posted + dt.timedelta(hours=STORY_TTL_HOURS)
    handle = norm["handle"]
    story_id = norm["story_id"]
    return {
        "detection_id": f"preview_{story_id}_{idx}",
        "creator_id": None,
        "creator_handle": handle,
        "creator_category": None,
        "platform": "instagram",
        "product_line": (verdict or {}).get("product_line"),
        # detected=None where nothing has judged the image: that renders as
        # "captured, not yet judged" rather than as a hit we did not earn.
        "confidence": (verdict or {}).get("confidence"),
        "size_in_frame": (verdict or {}).get("size_in_frame"),
        "is_primary_subject": (verdict or {}).get("is_primary_subject"),
        "image_url": image_url,
        "stored_path": None,
        "post_url": f"https://www.instagram.com/stories/{handle}/{story_id}/",
        "post_caption": None,
        "posted_at": posted.isoformat(),
        "likes_count": None,
        "comments_count": None,
        "views_count": None,
        "follower_count": None,
        "creator_tier": "tier_2",
        "verified": None,
        "context": (verdict or {}).get("context"),
        "post_hashtags": norm.get("hashtags") or [],
        "post_mentions": norm.get("mentions") or [],
        "music": None,
        "extras": None,
        "content_type": "story",
        "expires_at": expires.isoformat(),
        "frame_idx": None,
        # How many images the model actually received. Production writes one
        # detection document per frame, so the UI can count documents there;
        # 64_stories_analyse.py batches a video's frames into ONE call, so
        # without this a thirteen-frame verdict would render as "1 beeld
        # bekeken" — understating the evidence, which is the same failure as
        # overstating it.
        "frames_judged": (verdict or {}).get("frames_judged"),
        "post_id": f"instagram_story{story_id}",
        "surface_type": (verdict or {}).get("surface_type"),
        "visible_text": (verdict or {}).get("visible_text"),
        "false_positive_risk": (verdict or {}).get("false_positive_risk"),
        "people_count": (verdict or {}).get("people_count"),
        "setting": (verdict or {}).get("setting"),
        "activity": (verdict or {}).get("activity"),
        "gate": (verdict or {}).get("gate"),
        "verify_verdict": (verdict or {}).get("verify_verdict"),
        "verify_brand": (verdict or {}).get("verify_brand"),
        "verify_reason": (verdict or {}).get("verify_reason"),
        "sentiment": None,
        "sentiment_score": None,
        "sentiment_rationale": None,
        "brand_id": "stelz",
        "detected": verdict["detected"] if verdict else None,
        "is_false_positive": None,
    }


def to_post(norm: dict, image_url: str | None, video_url: str | None) -> dict:
    """One normalized story -> one StoryPost, matching lib/firestore.ts.

    The /stories page is driven by POSTS, not detections, so the preview has to
    supply posts or it would exercise a different code path than production.
    The verdicts ride alongside in preview-stories.json and are joined on
    postId, exactly as Firestore's two collections are.
    """
    posted = norm["posted_at"] or dt.datetime.now(dt.timezone.utc)
    expires = norm.get("expires_at") or posted + dt.timedelta(hours=STORY_TTL_HOURS)
    story_id = norm["story_id"]
    return {
        "postId": f"instagram_story{story_id}",
        "creatorHandle": norm["handle"],
        "creatorTier": "tier_2",
        "url": f"https://www.instagram.com/stories/{norm['handle']}/{story_id}/",
        "coverUrl": image_url,
        "videoUrl": video_url,
        "mediaType": norm["media_type"],
        "videoDuration": norm["video_duration"],
        "postedAt": posted.isoformat(),
        "postedAtEstimated": norm["posted_at"] is None,
        "expiresAt": expires.isoformat(),
        "hashtags": norm["hashtags"],
        "mentions": norm["mentions"],
        "pollVotes": norm["poll_votes"],
        "pollCount": norm["poll_count"],
        "pollQuestions": norm["poll_questions"],
        "linkUrls": norm["link_urls"],
        "music": norm["music"],
        "isPaidPartnership": norm["is_paid_partnership"],
    }


def archived_items() -> list[dict]:
    """The raw payloads 62_stories_archive.py kept, newest first.

    Preferred over re-reading Apify's last dataset, which holds only the MOST
    RECENT sweep: after two sweeps the archive had 96 stories and the dataset
    69, so a fixture built from Apify silently dropped 27 already-analysed
    stories off the page. The archive is the complete record and is free to
    read. Apify stays as the fallback for a machine with no archive yet.
    """
    if not RAW.is_dir():
        return []
    out = []
    for f in sorted(RAW.glob("*.json")):
        try:
            out.append(json.loads(f.read_text()))
        except Exception:
            continue
    return out


def main() -> int:
    items = archived_items()
    if items:
        print(f"Reading {len(items)} archived payloads from "
              f"{RAW.relative_to(ROOT)} (free, complete)")
    else:
        tok = token()
        if not tok:
            print("No archive and no APIFY_API_TOKEN — run 62_stories_archive.py first")
            return 2
        print(f"No archive; reading the last run of {STORIES_ACTOR} (no new run, no cost)")
        try:
            items = last_dataset_items(STORIES_ACTOR, tok)
        except Exception as e:
            print(f"  ✕ could not read the dataset: {e}")
            return 1
    print(f"  raw items: {len(items)}")

    verdicts = load_verdicts()
    archive = load_archive()
    local = have_media()
    print(f"  media: {'archived files via /preview-media' if local else 'signed CDN URLs (expire in hours)'}")

    rows, posts, leaked, from_archive = [], [], 0, 0
    for i, item in enumerate(items):
        norm = _normalize_item(item)
        if norm is None:
            leaked += 1
            continue
        arch = archive.get(norm["story_id"])
        img, vid = resolve_media(norm, arch, local)
        if local and arch:
            from_archive += 1
        v = verdicts.get(norm["story_id"])
        # Only stories that were actually judged get a detection row. An absent
        # row is what makes the UI say "nog niet geanalyseerd".
        if v is not None:
            rows.append(to_row(norm, i, v, img))
        posts.append(to_post(norm, img, vid))
    print(f"  stories after leak filter: {len(rows)}   rejected as non-story: {leaked}")

    if not rows:
        print("  → nothing to preview. Run 60_stories_smoke_test.py first.")
        return 1

    handles = sorted({r["creator_handle"] for r in rows})
    print(f"  from {len(handles)} accounts: {', '.join(handles)}")
    _write_atomic(OUT, json.dumps(rows, indent=1))
    _write_atomic(OUT_POSTS, json.dumps(posts, indent=1))
    polls = sum(p["pollVotes"] for p in posts)
    print(f"\n  wrote {OUT.relative_to(ROOT)} and {OUT_POSTS.relative_to(ROOT)}")
    judged = len(rows)
    hits = sum(1 for r in rows if r["detected"])
    print(f"  {sum(1 for p in posts if p['mediaType'] == 'video')} video · "
          f"{polls:,} poll votes · {sum(len(p['mentions']) for p in posts)} mentions")
    seen = sum(r["frames_judged"] or 1 for r in rows)
    print(f"  {judged} of {len(posts)} analysed on {seen} images · {hits} with Stëlz visible")
    if local:
        print(f"  {from_archive} of {len(posts)} served from the archive "
              f"(the exact bytes the analysis read)")
    if from_archive < len(posts):
        print(f"  ({len(posts) - from_archive} on signed CDN links — re-run 62_stories_archive.py)")
    if judged < len(posts):
        print(f"  ({len(posts) - judged} unjudged — run 64_stories_analyse.py)")
    print("  open http://localhost:5173/stories?preview=stories")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
