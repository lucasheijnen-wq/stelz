"""Creator feed refresh.

For each due creator (nextScanAt <= now), Apify-scrape recent posts, upsert
posts + images to Firestore, then enqueue detect_image messages on Pub/Sub
for each new image.

Equivalent to legacy 18_daily_scan.py (data acquisition phase only — detection
runs in detect_image function).
"""
from __future__ import annotations
import datetime as dt
import json
import logging
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any

from google.cloud import pubsub_v1
from google.cloud.firestore import SERVER_TIMESTAMP, Increment

from lib import apify, fs, scan_state, usage

log = logging.getLogger(__name__)

PROJECT_ID = "brand-audit-4b2cc"
DETECT_IMAGE_TOPIC = "detect-image"
DETECT_VIDEO_TOPIC = "detect-video"

# HOW LONG THIS FUNCTION MAY STAY, and why it is not the deployed 540.
#
# api_step_creators runs with timeout_sec=540. One Instagram batch is a
# synchronous apify.scrape_profile_ig -> run_sync(timeout=180), whose HTTP read
# allows 210 seconds. At most TWO of those fit in a call. Going over is not a
# slow scan, it is a killed container: Cloud Run drops the connection, the
# browser gets a bare TypeError, and — before the per-batch persist below —
# every scraped row died in memory while Apify had already billed for it. A
# 28-person roster is three batches, so this was reachable on the intended
# path, not only on the brand-wide one.
#
# So we stop STARTING batches while there is still room to finish the one in
# flight and write it down, and report what is left instead of being killed.
DEADLINE_S = 480          # of the deployed 540, leaving a minute to flush
BATCH_WORST_CASE_S = 210  # run_sync(timeout=180) plus its 30s read slack
PERSIST_MARGIN_S = 30


def run(brand_id: str, max_creators: int = 80, posts_per: int = 15, concurrency: int = 6,
        dry_run: bool = False, creator_ids: list[str] | None = None,
        deadline_s: float = DEADLINE_S) -> dict[str, Any]:
    """`creator_ids`: scan exactly these creator docs, ignoring nextScanAt.

    The default (None) keeps the due-queue behaviour the dashboard's brand-wide
    scan has always had. The named-set path exists for the EVENT pages, and the
    reason it ignores the due gate is the bug it was built to fix: a project
    roster sits on a 12-hour cadence, so a second press inside that window found
    nobody due and reported a perfectly successful scan of zero accounts. From
    the button that is indistinguishable from a scan that found nothing new,
    which is how "I pressed it and nothing changed" happens.

    Ids are `platform_handle` composites — the same ones projects store in
    creatorIds. Still capped by max_creators: a caller naming 500 handles is a
    cost incident, not a request."""
    started = time.monotonic()
    # EVERY return carries `scope`, including the ones that do nothing. The
    # event button reads its absence as "this backend predates creator_ids"
    # and says so in red; when only the success path stamped it, a scan
    # skipped for budget made a correctly deployed backend accuse itself of
    # not being deployed, while the real reason never reached the screen.
    scope = "named" if creator_ids is not None else "due"
    brand = fs.brand_doc(brand_id).get()
    if not brand.exists:
        raise ValueError(f"brand not found: {brand_id}")
    if usage.budget_exhausted(brand_id):
        return {"creators_scanned": 0, "posts_added": 0, "images_enqueued": 0, "videos_enqueued": 0, "skipped": "budget_exhausted", "scope": scope}
    if not usage.scraping_allowed(brand_id):
        # The 95% degrade rung, same gate refresh_profiles uses. Without it the
        # creator scan kept scraping at full width until the budget was fully
        # blown — and, before the record() fix below, without even reporting
        # the spend that was blowing it.
        return {"creators_scanned": 0, "posts_added": 0, "images_enqueued": 0, "videos_enqueued": 0, "skipped": "budget", "scope": scope}

    # Hoisted out of the due-query branch below: the re-schedule at the end of
    # this function stamps nextScanAt off it, so the named-set path needs it too.
    now = dt.datetime.now(dt.timezone.utc)

    # `is not None`, NOT truthiness. An empty list means "this caller meant to
    # name a roster and came up with nobody", and falling through to the due
    # queue there would quietly scrape the entire brand off an event button.
    if creator_ids is not None:
        # Named set: fetched by doc id, so no composite index and no `in`-query
        # cap of 30 — a 28-person roster is 56 ids across two platforms.
        wanted = [str(c).strip().lower() for c in creator_ids if str(c).strip()]
        refs = [fs.creators_col(brand_id).document(c) for c in wanted[:max_creators]]
        due = [d for d in fs.db().get_all(refs) if d.exists] if refs else []
        log.info(f"named creators: {len(due)} of {len(wanted)} requested exist")
        if not due:
            # Distinct from "found nothing": these creators are not tracked at
            # all, and the fix is to import the roster, not to scan again.
            return {"creators_scanned": 0, "posts_added": 0, "images_enqueued": 0,
                    "videos_enqueued": 0, "skipped": "no_creators", "scope": scope}
    else:
        # Fetch due creators (nextScanAt <= now, status in active set)
        due_q = (
            fs.creators_col(brand_id)
            .where("status", "in", ["discovered", "promoted"])
            .where("nextScanAt", "<=", now)
            .limit(max_creators)
            .stream()
        )
        due = [d for d in due_q]
        log.info(f"due creators: {len(due)}")
        if not due:
            return {"creators_scanned": 0, "posts_added": 0, "images_enqueued": 0,
                    "videos_enqueued": 0, "skipped": "no_creators", "scope": scope}

    # Build handle batches (Apify takes up to ~25 per call)
    posts_col = fs.posts_col(brand_id)
    # Items to fan out: (post_id, kind, url) where kind is 'image' or 'video'.
    new_items: list[tuple[str, str, str]] = []
    images_enqueued = 0
    videos_enqueued = 0
    posts_added = 0

    publisher = None if dry_run else pubsub_v1.PublisherClient()
    image_topic = None if publisher is None else publisher.topic_path(PROJECT_ID, DETECT_IMAGE_TOPIC)
    video_topic = None if publisher is None else publisher.topic_path(PROJECT_ID, DETECT_VIDEO_TOPIC)

    # Bucket all due creators by platform once
    handles_by_platform: dict[str, list[str]] = {"instagram": [], "tiktok": []}
    creator_by_handle: dict[str, Any] = {}
    for c in due:
        cd = c.to_dict() or {}
        platform = cd.get("platform", "instagram")
        handle = (cd.get("handle") or "").strip().lower()
        if not handle:
            continue
        handles_by_platform.setdefault(platform, []).append(handle)
        creator_by_handle[handle] = (c.reference, cd)

    apify_runs = 0  # one actor run per IG batch + one per TT profile
    ig_results = 0  # billed unit for IG ($ per result, not per run)
    tt_results = 0  # clockworks actor is free; recorded for visibility

    # ── Instagram: chunked batches (one Apify call per N handles) ─────
    # posts-mode profile-scraper gets slow for large user lists; splitting
    # keeps each Apify call under our function timeout budget.
    IG_BATCH = 10
    ig_handles = handles_by_platform.get("instagram") or []
    handles_left = 0  # unscraped handles when the deadline cut the loop short
    if ig_handles:
        all_ig_items: list[dict] = []
        for i in range(0, len(ig_handles), IG_BATCH):
            # THE DEADLINE, checked before starting — never mid-batch. A batch
            # we have paid Apify for must always reach the persist below.
            if (time.monotonic() - started) + BATCH_WORST_CASE_S + PERSIST_MARGIN_S > deadline_s:
                handles_left = len(ig_handles) - i
                log.info(f"  deadline: stopping with {handles_left} handles unscraped")
                break
            batch = ig_handles[i:i + IG_BATCH]
            try:
                items = apify.scrape_profile_ig(batch, posts_per)
                apify_runs += 1
                all_ig_items.extend(items)
                log.info(f"  IG batch {i // IG_BATCH + 1}: {len(batch)} handles -> {len(items)} items")
            except Exception as e:
                log.error(f"  IG apify batch error ({batch[:3]}...): {e}")
                continue
            # PERSIST AND BILL PER BATCH, not after the loop. This used to
            # accumulate every batch in all_ig_items and write the lot at the
            # end, so a container killed on the timeout wall wrote NOTHING
            # while Apify had already invoiced each finished batch — and
            # usage.record never ran either, so the spend that caused it was
            # invisible to the budget ladder. Whatever a batch cost, its rows
            # are on disk before the next one starts.
            for item in items:
                _persist_post(brand_id, item, "instagram", creator_by_handle, posts_col, new_items)
                posts_added += 1
            ig_results += len(items)
            usage.record(brand_id, apify_runs=1, apify_ig_results=len(items))
        _audit_creators_scrape(brand_id, "instagram", len(ig_handles), all_ig_items)

    # ── TikTok: parallel (clockworks runs one profile per actor call) ──
    tt_handles = handles_by_platform.get("tiktok") or []

    def _scrape_tt(h: str):
        try:
            return apify.run_sync(
                "clockworks/free-tiktok-scraper",
                {"profiles": [h], "resultsPerPage": posts_per, "shouldDownloadVideos": False},
                timeout=180,
            )
        except Exception as e:
            log.error(f"  TT apify {h} error: {e}")
            return []

    if tt_handles:
        all_tt_items: list[dict] = []
        with ThreadPoolExecutor(max_workers=concurrency) as ex:
            futures = {ex.submit(_scrape_tt, h): h for h in tt_handles}
            for fut in as_completed(futures):
                apify_runs += 1
                items = fut.result()
                all_tt_items.extend(items)
                for item in items:
                    _persist_post(brand_id, item, "tiktok", creator_by_handle, posts_col, new_items)
                    posts_added += 1
        tt_results = len(all_tt_items)
        _audit_creators_scrape(brand_id, "tiktok", len(tt_handles), all_tt_items)
        # TikTok bills per run at $0.0000 (clockworks is free) and its futures
        # all persist above before this line, so one record for the block is
        # equivalent to one per future. Instagram is NOT recorded here — it is
        # billed per batch inside the loop, and recording it twice would tell
        # the budget ladder the scan cost double what it did.
        usage.record(brand_id, apify_runs=len(tt_handles), apify_tt_results=tt_results)

    # Update lastScannedAt + nextScanAt for all due creators
    for c in due:
        cd = c.to_dict() or {}
        tier = cd.get("tier", "tier_3")
        cadence_h = {"tier_1": 6, "tier_2": 12, "tier_3": 48}.get(tier, 48)
        c.reference.update({
            "lastScannedAt": SERVER_TIMESTAMP,
            "nextScanAt": now + dt.timedelta(hours=cadence_h),
        })

    # Fan out: images → detect-image, videos → detect-video.
    # Wait on publish futures so messages are flushed before the function exits.
    if not dry_run and publisher:
        publish_futures = []
        for post_id, kind, url in new_items:
            payload = {"brandId": brand_id, "postId": post_id}
            if kind == "video":
                payload["videoUrl"] = url
                publish_futures.append(publisher.publish(video_topic, json.dumps(payload).encode()))
                videos_enqueued += 1
            else:
                payload["imageUrl"] = url
                publish_futures.append(publisher.publish(image_topic, json.dumps(payload).encode()))
                images_enqueued += 1
        if publish_futures:
            from concurrent.futures import wait as _fwait
            _fwait(publish_futures, timeout=30)
        # The scan panel's denominator. Only the hashtag path used to feed
        # detectTasksEnqueued while the detect workers' bump_detect_progress
        # counts completions from EVERY path — so completions overshot the
        # denominator, the bar clamped to 100% and the phase left 'analysing'
        # while this path's detections were still draining.
        #
        # Gated on an OPEN session, not unconditional. Without the gate a scan
        # that runs outside one raises the denominator of the last session that
        # closed, whose completions are frozen — a finished scan from last week
        # flips back to 'analysing' and prints an ETA measured from its own
        # week-old startedAt.
        if images_enqueued + videos_enqueued > 0 and scan_state.session_is_open(brand_id):
            fs.brand_doc(brand_id).set({"scan": {
                "detectTasksEnqueued": Increment(images_enqueued + videos_enqueued),
                "lastActivityAt": SERVER_TIMESTAMP,
            }}, merge=True)

    fs.scan_runs_col(brand_id).add({
        "type": "scan_creators",
        "startedAt": SERVER_TIMESTAMP,
        "finishedAt": SERVER_TIMESTAMP,
        "stats": {
            "creatorsScanned": len(due),
            "postsAdded": posts_added,
            "imagesEnqueued": images_enqueued,
            "videosEnqueued": videos_enqueued,
        },
        "status": "ok",
    })
    return {
        "creators_scanned": len(due),
        "posts_added": posts_added,
        "images_enqueued": images_enqueued,
        "videos_enqueued": videos_enqueued,
        # HOW the creators were chosen — the event button reads this back. A
        # deployed backend that predates creator_ids silently ignores the field
        # and scans the due queue instead of the roster it was asked for; the
        # marker's ABSENCE in the response is how the frontend detects that and
        # says so, rather than reporting a roster scan that never happened.
        "scope": scope,
        # Handles the deadline did not get to. Non-zero means "press again for
        # the rest" — the caller repeats rather than assuming this was all of
        # it, which is what made a truncated scan look like a complete one.
        "more_remaining": handles_left,
    }


def _persist_post(
    brand_id: str,
    item: dict,
    platform: str,
    creator_by_handle: dict,
    posts_col,
    new_items: list,
) -> None:
    handle = (item.get("ownerUsername") or item.get("authorMeta", {}).get("name") or "").strip().lower()
    if not handle or handle not in creator_by_handle:
        return
    creator_ref, _cd = creator_by_handle[handle]

    video_url: str | None = None  # if set, post is a video; fans out to detect-video
    music: dict | None = None
    extras: dict | None = None
    follower_count: int | None = None
    child_posts: list[dict] = []  # IG Sidecar children; empty everywhere else

    if platform == "instagram":
        ext_id = str(item.get("id") or item.get("shortCode") or "")
        # The SHORTCODE, kept beside the doc id rather than as it. The import
        # path (78_upload_event.post_doc_id) names posts instagram_<shortCode>
        # while this scanner names the same post instagram_<numeric id>, so the
        # two never collide and every roster post counted twice once an online
        # scan ran over already-imported rows. Changing either doc id would
        # split the rows already in Firestore; a shared KEY dedupes them
        # without a migration. Lowercased because composite_id lowercases and
        # the fixture's postKey does not.
        post_key = str(item.get("shortCode") or "").lower() or None
        url = item.get("url")
        caption = item.get("caption") or ""
        hashtags = item.get("hashtags") or []
        mentions = item.get("mentions") or []
        posted_at_iso = item.get("timestamp")
        # NO `or 0` on the metrics. Instagram omits the field when a count is
        # hidden and omits videoViewCount on every photo, so `or 0` turned "not
        # published" into "zero" — and the KPI tiles average over posts that
        # carry a number, so a photo claiming zero views dragged the mean of
        # every video down with it. Absent stays absent; a real 0 stays 0.
        likes = item.get("likesCount")
        comments = item.get("commentsCount")
        views = item.get("videoViewCount")
        is_video = item.get("type") == "Video" or bool(item.get("videoUrl"))
        if is_video:
            video_url = item.get("videoUrl")  # signed CDN URL, short-lived
        # IG Reels audio. The hashtag-scan path has written this since day one
        # (scan_hashtags.py musicInfo branch) but this deep-scan path never did
        # — so a creator's reels showed music when found via #stelz and none
        # when found via their own feed, and the sounds dashboard undercounted
        # exactly the tracked creators it matters most for.
        mi = item.get("musicInfo") or {}
        if mi:
            music = {
                "title": mi.get("songName") or mi.get("song_name") or mi.get("title"),
                "artist": mi.get("artistName") or mi.get("artist_name") or mi.get("author"),
                "original": bool(mi.get("isOriginal")),
            }
        # Carousel / single
        child_posts = item.get("childPosts") or []
        images = child_posts
        if not images and item.get("displayUrl"):
            images = [{"displayUrl": item.get("displayUrl")}]
        image_urls = [img.get("displayUrl") for img in images if img.get("displayUrl")]
    else:  # tiktok — always a video
        follower_count = (item.get("authorMeta") or {}).get("fans")
        ext_id = str(item.get("id") or item.get("aweme_id") or "")
        # TikTok has no shortcode; its numeric id IS the stable public key and
        # the import path uses the same one, so they already agree.
        post_key = ext_id.lower() or None
        url = item.get("webVideoUrl") or item.get("shareUrl")
        caption = item.get("text") or item.get("desc") or ""
        hashtags = [h.get("name") for h in (item.get("hashtags") or []) if h.get("name")]
        mentions = [m for m in (item.get("mentions") or []) if isinstance(m, str)]
        posted_at_iso = item.get("createTimeISO") or item.get("createTime")
        # Same rule as Instagram above: a missing count is unknown, not zero.
        likes = item.get("diggCount")
        comments = item.get("commentCount")
        views = item.get("playCount")
        video_url = (
            item.get("videoMeta", {}).get("downloadAddr")
            or item.get("downloadAddr")
            or item.get("videoUrl")
            or item.get("webVideoUrl")
        )
        image_urls = [item.get("videoMeta", {}).get("coverUrl")]
        image_urls = [u for u in image_urls if u]

        # Rich extras
        mm = item.get("musicMeta") or {}
        if mm:
            from .scan_hashtags import _tiktok_music_url
            mid = mm.get("musicId")
            music = {
                "title": mm.get("musicName"),
                "artist": mm.get("musicAuthor"),
                "musicId": mid,
                "original": bool(mm.get("musicOriginal")),
                "playUrl": mm.get("playUrl"),
                "url": _tiktok_music_url(mid, mm.get("musicName")),
                "coverUrl": mm.get("coverMediumUrl") or mm.get("originalCoverMediumUrl"),
            }
        else:
            music = None
        vmeta = item.get("videoMeta") or {}
        ameta = item.get("authorMeta") or {}
        loc = item.get("locationMeta") or {}
        extras = {
            "shareCount": item.get("shareCount") or 0,
            "collectCount": item.get("collectCount") or 0,
            "repostCount": item.get("repostCount") or 0,
            "isPinned": bool(item.get("isPinned")),
            "isAd": bool(item.get("isAd")),
            "isSponsored": bool(item.get("isSponsored")),
            "isSlideshow": bool(item.get("isSlideshow")),
            "duration": vmeta.get("duration"),
            "definition": vmeta.get("definition"),
            "width": vmeta.get("width"),
            "height": vmeta.get("height"),
            "effects": [s.get("name") for s in (item.get("effectStickers") or []) if s.get("name")],
            "textLanguage": item.get("textLanguage"),
            "location": ({
                "city": loc.get("locationName") or loc.get("city"),
                "country": loc.get("address"),
            } if loc else None),
            "author": ({
                "nickName": ameta.get("nickName"),
                "avatar": ameta.get("avatar"),
                "verified": bool(ameta.get("verified")),
                "signature": (ameta.get("signature") or "")[:300],
                "profileUrl": ameta.get("profileUrl"),
                "ttSeller": bool(ameta.get("ttSeller")),
                "privateAccount": bool(ameta.get("privateAccount")),
            } if ameta else None),
        }

    if not ext_id:
        return

    post_id = fs.composite_id(platform, ext_id)

    # Dedupe handled downstream (imageHashCache + videoProcessed flag).
    posted_at = None
    if posted_at_iso:
        try:
            posted_at = dt.datetime.fromisoformat(posted_at_iso.replace("Z", "+00:00")) if isinstance(posted_at_iso, str) else dt.datetime.fromtimestamp(int(posted_at_iso), dt.timezone.utc)
        except Exception:
            posted_at = None

    from .scan_hashtags import _tagged_users
    doc = {
        "creatorRef": creator_ref.path,
        "creatorHandle": handle,
        "platform": platform,
        "externalId": ext_id,
        # The cross-path identity — see post_key above. dedupeDocs in the web
        # client collapses on this before falling back to the doc id, so an
        # imported row and a scanned row for the same post become one row.
        "postKey": post_key,
        "url": url,
        "caption": caption[:2000],
        "hashtags": [h.lower() for h in hashtags],
        "mentions": mentions,
        # Who is tagged IN the media — expand_audience turns these into
        # discovery candidates and graph edges. Same field the hashtag path
        # writes, so a post carries it whichever route found it first.
        "taggedUsers": _tagged_users(item),
        "postedAt": posted_at,
        "likesCount": likes,
        "commentsCount": comments,
        "viewsCount": views,
        "music": music,
        "ingestedAt": SERVER_TIMESTAMP,
    }
    # detect_image copies followerCount from the post onto every detection, so
    # a post that doesn't carry it produces detections that can't show it.
    if follower_count:
        doc["followerCount"] = int(follower_count)
    if extras:
        doc["extras"] = extras
    posts_col.document(post_id).set(doc, merge=True)

    # Keep the creator record current too — it is what compute_resonance reads,
    # and what the Creator page falls back to when detections lack the number.
    if follower_count or extras:
        patch: dict[str, Any] = {}
        if follower_count:
            patch["followerCount"] = int(follower_count)
        author = (extras or {}).get("author") or {}
        if author.get("signature"):
            patch["bio"] = author["signature"]
        if author.get("avatar"):
            patch["avatarUrl"] = author["avatar"]
        if patch:
            creator_ref.set(patch, merge=True)

    # Persist content-type + optional video URL on the post.
    content_type = "video" if video_url else ("image" if image_urls else "unknown")
    posts_col.document(post_id).set({
        "contentType": content_type,
        "videoUrl": video_url,
    }, merge=True)

    # Fan-out queue: prefer video detect path if we have a video URL.
    # Otherwise fall back to the cover image(s).
    if video_url:
        new_items.append((post_id, "video", video_url))

    # IG carousels: one post doc PER SLIDE, fanned out under the CHILD
    # composite id — the model the hashtag path has always used
    # (scan_hashtags._persist_sidecar_child). This deep-scan used to fan every
    # slide out under the PARENT id, so one slide found via both routes made
    # TWO detection docs: instagram_{parent}_{child}_{hash} next to
    # instagram_{parent}_{hash}. parentPostKey (first two id segments)
    # collapses both on screen, but the double bookkeeping — and the second
    # Gemini call when the two endpoints serve different bytes — stops here,
    # at the source. A child the helper cannot key (no id, no media) falls
    # back to the parent-keyed fan-out below so coverage never drops.
    handled_child_urls: set[str] = set()
    if child_posts:
        from .scan_hashtags import _persist_sidecar_child
        for child in child_posts:
            c_id, c_kind, c_url, c_cover = _persist_sidecar_child(
                brand_id, item, child, handle, posts_col)
            if not c_id or not c_url:
                continue
            new_items.append((c_id, c_kind, c_url))
            if c_cover:
                new_items.append((c_id, "image", c_cover))
            if child.get("displayUrl"):
                handled_child_urls.add(child["displayUrl"])

    for idx, img_url in enumerate(image_urls):
        img_id = fs.composite_id(post_id, str(idx))
        # The sequence view under the parent stays for every slide — it is how
        # the post renders as one carousel — only the detect fan-out moves to
        # the child ids.
        posts_col.document(post_id).collection("images").document(img_id).set({
            "url": img_url,
            "sequenceIdx": idx,
            "ingestedAt": SERVER_TIMESTAMP,
        }, merge=True)
        if img_url in handled_child_urls:
            continue
        # Always analyse the cover image, including for videos.
        #
        # This used to be skipped when video_url was set, to "avoid double work".
        # But the video path fails often and by design: TikTok blocks GCP egress
        # IPs (see scan_hashtags.py:189-192) and Instagram videoUrls are
        # short-lived signed CDN URLs that expire while queued behind
        # max_instances=25. When it fails, the post produced ZERO detections —
        # despite a perfectly good cover JPEG already being scraped and stored.
        #
        # Only the first frame of a carousel is used as a video cover, so the
        # extra cost is one Flash call per video post, and it is the only pass
        # that reliably succeeds.
        if not video_url or idx == 0:
            new_items.append((post_id, "image", img_url))


def _shrink_value_c(v, max_str: int = 200):
    if v is None or isinstance(v, (int, float, bool)):
        return v
    if isinstance(v, str):
        return v[:max_str]
    if isinstance(v, list):
        return [_shrink_value_c(x, 120) for x in v[:5]]
    if isinstance(v, dict):
        return {k: _shrink_value_c(v[k], 120) for k in list(v.keys())[:12]}
    return f"<{type(v).__name__}>"


def _shrink_sample_c(sample: dict) -> dict:
    return {k: _shrink_value_c(sample[k], 200) for k in list(sample.keys())[:30]}


def _audit_creators_scrape(brand_id: str, platform: str, handles_count: int, items: list[dict]) -> None:
    """Per-platform creator-scrape breakdown for the Debug tab.
    Mirrors scan_hashtags._audit_scrape but with handles_count instead of tag."""
    if not items:
        try:
            fs.brand_doc(brand_id).collection("scrapeLog").add({
                "tag": f"{handles_count} handles",
                "platform": platform,
                "itemsReturned": 0,
                "source": "scan_creators",
                "createdAt": SERVER_TIMESTAMP,
            })
        except Exception:
            pass
        return

    kinds: dict[str, int] = {}
    has_video_url = 0
    has_display_url = 0
    has_download_addr = 0
    for it in items:
        if platform == "instagram":
            # Apify profile-scraper uses several names depending on resultsType.
            t = (
                it.get("type")
                or it.get("productType")
                or it.get("__typename")
                or ("ProfileDetails" if it.get("latestPosts") else None)
                or "Unknown"
            )
            kinds[t] = kinds.get(t, 0) + 1
            if it.get("videoUrl") or it.get("video_url"):
                has_video_url += 1
            if it.get("displayUrl") or it.get("display_url"):
                has_display_url += 1
        else:
            kinds["Video"] = kinds.get("Video", 0) + 1
            vm = it.get("videoMeta") or {}
            if vm.get("downloadAddr") or it.get("downloadAddr") or it.get("videoUrl"):
                has_download_addr += 1
            if it.get("webVideoUrl"):
                has_video_url += 1
            if vm.get("coverUrl"):
                has_display_url += 1

    sample = items[0] if items else None
    sample_keys = sorted(sample.keys()) if isinstance(sample, dict) else None
    if isinstance(sample, dict):
        sample = _shrink_sample_c(sample)

    try:
        fs.brand_doc(brand_id).collection("scrapeLog").add({
            "tag": f"{handles_count} handles",
            "platform": platform,
            "itemsReturned": len(items),
            "breakdown": {
                "kinds": kinds,
                "hasVideoUrl": has_video_url,
                "hasDisplayUrl": has_display_url,
                "hasDownloadAddr": has_download_addr,
            },
            "sampleKeys": sample_keys,
            "sample": sample,
            "source": "scan_creators",
            "createdAt": SERVER_TIMESTAMP,
        })
    except Exception:
        pass
