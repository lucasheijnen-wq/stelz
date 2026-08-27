"""Instagram Stories capture.

Stories are where most in-the-moment brand mentions live, and they are gone in
24 hours. Two earlier prototypes (tools/stelz_brand_watch/44 and /49) never
produced a story in production, and the research explains why: the official
`apify/instagram-scraper` has NO stories support at all — its resultsType
accepts posts/reels/comments/mentions/details, so `resultsType: "stories"` was
never going to return one. The prototypes blamed the missing session cookie.

Active stories ARE login-gated at Instagram's own API. The way out is not to
supply a cookie — a session cookie is a live account credential that expires,
needs manual re-harvesting, and puts a real person's account at risk of a
permanent ban. Instead this uses an actor that runs its own session pool: the
account risk sits with the vendor, and nothing here holds a credential.

Cadence: a story lives 24h, so ANY polling interval <= 24h captures every one
of them. The scheduler runs this every 6h — 4x redundancy, so a story survives
three consecutive failed runs and is still caught. Polling more often buys no
extra coverage, only cost.

An empty result is the NORMAL case: most creators have no active story at any
given moment. It is reported as zero stories with status ok, never as an error.
"""
from __future__ import annotations

import datetime as dt
import json
import logging
from typing import Any

from google.cloud import pubsub_v1
from google.cloud.firestore import SERVER_TIMESTAMP, Increment

from lib import apify, fs, usage

log = logging.getLogger(__name__)

PROJECT_ID = "brand-audit-4b2cc"
DETECT_IMAGE_TOPIC = "detect-image"
DETECT_VIDEO_TOPIC = "detect-video"

# No-login actor: it maintains its own Instagram sessions, so we hold no
# credential and no account of ours can be banned for this.
# $0.099 per run + $3/1k usernames — batch every handle into ONE run.
STORIES_ACTOR = "datavoyantlab/advanced-instagram-stories-scraper"

STORY_TTL_HOURS = 24
DEFAULT_MAX_HANDLES = 60


def _actor_payload(handles: list[str]) -> dict[str, Any]:
    """Actor input. Swap point 1 — changing vendor means changing this and
    _normalize_item, nothing else."""
    return {"usernames": handles}


def _epoch(v: Any) -> dt.datetime | None:
    """Instagram timestamps are epoch seconds. Anything else is not a time."""
    if isinstance(v, (int, float)) and v > 1e9:
        return dt.datetime.fromtimestamp(v, tz=dt.timezone.utc)
    return None


def _normalize_item(item: dict) -> dict | None:
    """Actor output -> our shape, or None when the item is not a story.

    Swap point 2, and the part that was wrong. Both vendors return Instagram's
    OWN media object — snake_case, not the camelCase feed-post shape the two
    prototypes guessed at. A live run against the Lowlands roster returned 69
    genuine stories and the previous filter rejected all 69, chiefly because
    `id` is "{media_id}_{user_id}" and the check demanded str.isdigit().

    The leak test is now the positive one: Instagram itself labels the media
    `product_type`, and a story says "story". That is a fact from the payload
    rather than the old "a story has no shortCode" heuristic — which is simply
    false, every one of those 69 carried a `code`.

    Deliberately NOT reading `pk`: it is a 64-bit id that JSON hands over as a
    float, so 3967203771136678414 arrives as ...678400. `id` keeps every digit.
    """
    if item.get("product_type") != "story":
        return None
    raw_id = str(item.get("id") or "")
    story_id = raw_id.split("_", 1)[0]
    if not story_id.isdigit():
        return None

    user = item.get("user") or {}
    handle = (item.get("username") or user.get("username") or "").strip().lower().lstrip("@")
    if not handle:
        return None

    # Candidates come widest-first; the first is the full-resolution frame,
    # which is what the detector should see.
    candidates = (item.get("image_versions2") or {}).get("candidates") or []
    image_url = next((c.get("url") for c in candidates if c.get("url")), None)
    videos = item.get("video_versions") or []
    video_url = next((v.get("url") for v in videos if v.get("url")), None)

    return {
        "story_id": story_id,
        "handle": handle,
        "posted_at": _epoch(item.get("taken_at")),
        # Instagram states the real expiry. Prefer it over posted_at + 24h:
        # a story whose author extended it, or one captured near the boundary,
        # gets the true countdown rather than our arithmetic.
        "expires_at": _epoch(item.get("expiring_at")),
        "video_url": video_url,
        "image_url": image_url,
        # A story that @-mentions the brand is a hit whether or not a can is in
        # frame, and the tags say which scene it belongs to. Both were being
        # written as empty lists while the payload carried them.
        "mentions": [
            (m.get("user") or {}).get("username", "").lower()
            for m in (item.get("reel_mentions") or [])
            if (m.get("user") or {}).get("username")
        ],
        "hashtags": [
            (h.get("hashtag") or {}).get("name", "").lower()
            for h in (item.get("story_hashtags") or [])
            if (h.get("hashtag") or {}).get("name")
        ],
        # 1 = photo, 2 = video. Recorded rather than inferred from video_url,
        # which is absent whenever the vendor could not resolve the stream.
        "media_type": "video" if item.get("media_type") == 2 else "image",
        "video_duration": item.get("video_duration"),
        # Instagram will not tell a third party how many people saw a story
        # (`can_see_insights_as_brand` is false on every item). Poll tallies,
        # however, ARE public, and they are the only real engagement number
        # obtainable here — 13,442 votes on one of these.
        "poll_votes": _poll_votes(item),
        "poll_count": len(item.get("story_polls") or []),
        "poll_questions": [
            q for q in (
                ((p.get("poll_sticker") or {}).get("question") or "").strip()
                for p in (item.get("story_polls") or [])
            ) if q
        ],
        # Swipe-up targets. A story linking to drinkstelz.com is a conversion,
        # not just an impression.
        "link_urls": [
            (s.get("story_link") or {}).get("display_url")
            for s in (item.get("story_link_stickers") or [])
            if (s.get("story_link") or {}).get("display_url")
        ],
        "music": _music(item),
        "is_paid_partnership": bool(item.get("is_paid_partnership")),
        # Free profile data. Instagram avatars otherwise require a separate
        # refresh_profiles scrape, and these ride along at no cost.
        "full_name": (user.get("full_name") or "").strip() or None,
        "avatar_url": user.get("profile_pic_url") or None,
        "is_verified": bool(user.get("is_verified")),
    }


def _poll_votes(item: dict) -> int:
    """Total votes across every poll sticker on the story.

    This is the only hard viewing number obtainable from outside the account:
    a vote requires a person who saw the story, so N votes is a verified FLOOR
    on how many people saw it — not an estimate. One of these carried 18,412.

    Instagram reports `total_votes` and also itemised `tallies`; the two agreed
    exactly across every poll in the sample, so the stated total wins and the
    sum is the fallback for a payload that omits it.
    """
    total = 0
    for poll in item.get("story_polls") or []:
        sticker = poll.get("poll_sticker") or {}
        stated = sticker.get("total_votes")
        if isinstance(stated, int):
            total += stated
            continue
        for tally in sticker.get("tallies") or []:
            c = tally.get("count")
            if isinstance(c, int):
                total += c
    return total


def _music(item: dict) -> dict | None:
    """First music sticker, in the same shape post docs already use for music,
    so story sounds flow into the existing Sounds page without a special case."""
    for sticker in item.get("story_music_stickers") or []:
        info = sticker.get("music_asset_info") or {}
        title = info.get("title") or info.get("display_artist")
        if not title:
            continue
        return {
            "title": info.get("title"),
            "artist": info.get("display_artist"),
            "musicId": info.get("audio_asset_id") or info.get("id"),
        }
    return None


def _enrich_creator(creator_ref: Any, current: dict, norm: dict) -> None:
    """Fill blank creator fields from the story payload. Free profile data.

    BACKFILL ONLY, never overwrite — same rule as handlers/projects.py holds for
    fullName. refresh_profiles scrapes these deliberately and more accurately;
    this only helps a creator who has never been through that pass. An avatar
    here is also the sole no-cost source of Instagram profile pictures, which
    otherwise need their own paid scrape.

    Never raises: a profile nicety must not fail a story sweep.
    """
    patch: dict[str, Any] = {}
    if not current.get("fullName") and norm.get("full_name"):
        patch["fullName"] = norm["full_name"]
    if not current.get("avatarUrl") and norm.get("avatar_url"):
        patch["avatarUrl"] = norm["avatar_url"]
    if current.get("verifiedAccount") is None and norm.get("is_verified"):
        patch["verifiedAccount"] = True
    if not patch:
        return
    try:
        creator_ref.set(patch, merge=True)
    except Exception:
        log.exception("could not enrich creator from story payload")


def _mark_run(brand_id: str, *, found: int, checked: int, skipped: str | None = None) -> None:
    """Stamp the brand doc with the outcome of this sweep.

    Separate from `scan.steps.stories` on purpose. That map belongs to a scan
    SESSION and is cleared when the next one starts, while three quarters of
    these runs come from the 6-hourly scheduler, which has no session at all.
    Without this the stories panel could never answer the first question anyone
    asks it — "when did this last look?" — and an empty strip would be
    indistinguishable from a scheduler that silently stopped firing.

    Never raises: reporting must not be able to fail a sweep that succeeded.
    """
    try:
        fs.brand_doc(brand_id).set({"stories": {
            "lastRunAt": SERVER_TIMESTAMP,
            "lastFound": found,
            "lastChecked": checked,
            "lastSkipped": skipped,
        }}, merge=True)
    except Exception:
        log.exception(f"[{brand_id}] could not stamp stories run")


def run(brand_id: str, max_handles: int = DEFAULT_MAX_HANDLES, dry_run: bool = False,
        session_counters: bool = False,
        creator_ids: list[str] | None = None) -> dict[str, Any]:
    """`creator_ids`: take stories for exactly these creator docs.

    The default (None) keeps the tier-based sweep. The named-set path is for the
    EVENT pages: the tier query carries a `limit` and no ordering, so on a brand
    with more tracked creators than the limit it is arbitrary which ones a run
    covers — an event roster could sit outside it and the button would look
    like it worked while never touching the people it was pressed for.

    Ids are `platform_handle` composites; the Instagram ones are used and the
    rest ignored, because stories are an Instagram surface.

    `session_counters`: bump scan.detectTasksEnqueued for this run's fan-out.

    True only for the HTTP step a person started from the dashboard — the scan
    panel's denominator must count the work THAT session enqueued. The 6-hourly
    scheduler leaves it False: repainting a human-watched panel from a
    background sweep is exactly what the stories block on the brand doc exists
    to avoid."""
    brand = fs.brand_doc(brand_id).get()
    if not brand.exists:
        raise ValueError(f"brand not found: {brand_id}")

    zero = {"accountsChecked": 0, "storiesFound": 0, "imagesEnqueued": 0,
            "videosEnqueued": 0, "skippedNonStory": 0}
    if usage.budget_exhausted(brand_id):
        _mark_run(brand_id, found=0, checked=0, skipped="budget_exhausted")
        return {**zero, "skipped": "budget_exhausted"}
    if not usage.scraping_allowed(brand_id):
        _mark_run(brand_id, found=0, checked=0, skipped="budget")
        return {**zero, "skipped": "budget"}

    # `is not None`, not truthiness — see the same note in scan_creators: an
    # empty named set must not fall back to the brand-wide sweep.
    if creator_ids is not None:
        # Named set, by doc id. Stories are Instagram-only, so a roster's TikTok
        # ids are dropped here rather than fetched and silently ignored later.
        wanted = [str(c).strip().lower() for c in creator_ids
                  if str(c).strip().startswith("instagram_")][:max_handles]
        refs = [fs.creators_col(brand_id).document(c) for c in wanted]
        due = [d for d in fs.db().get_all(refs) if d.exists] if refs else []
    else:
        # Tracked creators only. Stories cost more per call than feed posts, and
        # a tier_3 creator is by definition one nobody asked us to follow
        # closely. Project members (the Lowlands roster) are tier_2, so they are
        # included.
        due = list(
            fs.creators_col(brand_id)
            .where("platform", "==", "instagram")
            .where("tier", "in", ["tier_1", "tier_2"])
            .limit(max_handles)
            .stream()
        )
    by_handle: dict[str, Any] = {}
    for c in due:
        cd = c.to_dict() or {}
        h = (cd.get("handle") or "").strip().lower()
        if h:
            by_handle[h] = (c.reference, cd)
    handles = list(by_handle)
    if not handles:
        _mark_run(brand_id, found=0, checked=0, skipped="no_creators")
        return {**zero, "skipped": "no_creators"}

    items: list[dict] = []
    try:
        # ONE run for every handle: the actor charges a per-run fee that dwarfs
        # the per-username price, so 28 separate runs cost ~16x one batched run.
        items = apify.run_sync(STORIES_ACTOR, _actor_payload(handles), timeout=300, memory=1024)
    except Exception as e:
        log.error(f"[{brand_id}] stories actor failed: {e}")
    finally:
        # Recorded even when the run threw: the actor start is billed whether or
        # not we got items back, and a budget guard that under-reports is the
        # bug this codebase already had once.
        usage.record(brand_id, apify_story_runs=1, apify_story_usernames=len(handles))

    posts_col = fs.posts_col(brand_id)
    publisher = None if dry_run else pubsub_v1.PublisherClient()
    image_topic = None if publisher is None else publisher.topic_path(PROJECT_ID, DETECT_IMAGE_TOPIC)
    video_topic = None if publisher is None else publisher.topic_path(PROJECT_ID, DETECT_VIDEO_TOPIC)

    new_items: list[tuple[str, str, str]] = []
    stories_found = 0
    skipped_non_story = 0
    reseen = 0
    now = dt.datetime.now(dt.timezone.utc)

    for item in items:
        norm = _normalize_item(item)
        if norm is None:
            skipped_non_story += 1
            continue
        handle = norm["handle"]
        if handle not in by_handle:
            # Vendor returned an account we never asked about.
            skipped_non_story += 1
            continue
        creator_ref, cd = by_handle[handle]

        posted_at = norm["posted_at"] or now
        story_id = norm["story_id"]
        # No separator inside the second segment. The frontend collapses frames
        # and carousel slots into one row per post by taking the first two
        # underscore-separated parts of the post id (lib/types.parentPostKey), so
        # "instagram_story_123" reads as post "story" and EVERY story in the feed
        # would dedupe down to a single row.
        post_id = fs.composite_id("instagram", f"story{story_id}")

        doc: dict[str, Any] = {
            "creatorRef": creator_ref.path,
            "creatorHandle": handle,
            "creatorTier": cd.get("tier"),
            "platform": "instagram",
            "externalId": f"story_{story_id}",
            # A story permalink, not the raw CDN image: "open original" on a
            # story should look like a story, not like a stray JPEG.
            "url": f"https://www.instagram.com/stories/{handle}/{story_id}/",
            "caption": "",
            "hashtags": norm["hashtags"],
            "mentions": norm["mentions"],
            "postedAt": posted_at,
            # Instagram's own expiry when it gave us one, our arithmetic when
            # it did not. Both prototypes promised this field and neither wrote
            # it at all.
            "expiresAt": norm["expires_at"] or (posted_at + dt.timedelta(hours=STORY_TTL_HOURS)),
            "contentType": "story",
            "mediaType": norm["media_type"],
            "videoUrl": norm["video_url"],
            "videoDuration": norm["video_duration"],
            "coverUrl": norm["image_url"],
            "likesCount": 0,
            "commentsCount": 0,
            # NOT zero. Instagram shows story views to the account owner only
            # (`can_see_insights_as_brand` is false on every item), so we do not
            # know this number. Writing 0 states that nobody watched, which is
            # a claim, and one that would be read straight into a client report.
            "viewsCount": None,
            # Poll votes are the exception: a vote requires someone who saw the
            # story, so this is a verified floor on views rather than a guess.
            "pollVotes": norm["poll_votes"],
            "pollCount": norm["poll_count"],
            "pollQuestions": norm["poll_questions"],
            "linkUrls": norm["link_urls"],
            "music": norm["music"],
            "isPaidPartnership": norm["is_paid_partnership"],
            "ingestedAt": SERVER_TIMESTAMP,
            "ingestedBy": "scan_stories",
        }
        if norm["posted_at"] is None:
            doc["postedAtEstimated"] = True

        # Already have it? A story lives 24h and the sweep runs every 6h, so
        # the same story comes back up to four times. Re-analysing it costs no
        # Gemini (imageHashCache absorbs that) but does cost four image fetches
        # and four Storage writes where one would do.
        existed = posts_col.document(post_id).get().exists
        posts_col.document(post_id).set(doc, merge=True)
        stories_found += 1
        if existed:
            reseen += 1

        if norm["image_url"]:
            img_id = fs.composite_id(post_id, "0")
            posts_col.document(post_id).collection("images").document(img_id).set({
                "url": norm["image_url"],
                "sequenceIdx": 0,
                "ingestedAt": SERVER_TIMESTAMP,
            }, merge=True)
        if not existed:
            if norm["video_url"]:
                new_items.append((post_id, "video", norm["video_url"]))
            # The cover is analysed even for video stories: story video URLs are
            # short-lived signed CDN links that routinely expire while queued,
            # and the cover is the pass that reliably succeeds (same reasoning
            # as scan_creators._persist_post).
            if norm["image_url"]:
                new_items.append((post_id, "image", norm["image_url"]))

        _enrich_creator(creator_ref, cd, norm)

    images_enqueued = 0
    videos_enqueued = 0
    if not dry_run and publisher:
        futures = []
        for post_id, kind, url in new_items:
            payload = {"brandId": brand_id, "postId": post_id}
            if kind == "video":
                payload["videoUrl"] = url
                futures.append(publisher.publish(video_topic, json.dumps(payload).encode()))
                videos_enqueued += 1
            else:
                payload["imageUrl"] = url
                futures.append(publisher.publish(image_topic, json.dumps(payload).encode()))
                images_enqueued += 1
        if futures:
            from concurrent.futures import wait as _fwait
            _fwait(futures, timeout=30)
        # Same denominator rule as scan_creators: the detect workers count
        # completions from every path, so every path that enqueues must also
        # count — but only when a person is watching this scan session.
        if session_counters and images_enqueued + videos_enqueued > 0:
            fs.brand_doc(brand_id).set({"scan": {
                "detectTasksEnqueued": Increment(images_enqueued + videos_enqueued),
                "lastActivityAt": SERVER_TIMESTAMP,
            }}, merge=True)
    else:
        videos_enqueued = sum(1 for _, k, _ in new_items if k == "video")
        images_enqueued = sum(1 for _, k, _ in new_items if k == "image")

    stats = {
        "accountsChecked": len(handles),
        "storiesFound": stories_found,
        "imagesEnqueued": images_enqueued,
        "videosEnqueued": videos_enqueued,
        "skippedNonStory": skipped_non_story,
        # Stories we had already captured on an earlier sweep. Metadata is
        # refreshed (poll counts climb while a story is live) but the image is
        # not re-analysed.
        "alreadyHad": reseen,
    }
    _mark_run(brand_id, found=stories_found, checked=len(handles))
    fs.scan_runs_col(brand_id).add({
        "type": "scan_stories",
        "startedAt": SERVER_TIMESTAMP,
        "finishedAt": SERVER_TIMESTAMP,
        "stats": stats,
        "status": "ok",
    })
    log.info(f"[{brand_id}] stories: {stats}")
    return stats
