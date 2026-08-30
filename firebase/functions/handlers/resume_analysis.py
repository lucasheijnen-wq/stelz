"""Re-enqueue analysis for media that never got any.

WHY A SCAN NEEDS THIS AT ALL. The detect fan-out is Pub/Sub, published with
retry unset — which firebase_functions serialises as retry=false — so a message
whose worker is killed by the 180s/300s container deadline, or by an OOM, is
gone and nothing redelivers it. scan_watchdog was deliberately removed
(main.py:70). Until now the only record that work had been lost was a counter
that stopped short, and a counter cannot tell you WHICH images to redo.

WHAT COUNTS AS "NEVER ANALYSED", and why it is trustworthy. detect_image writes
a detection document on every completed analysis — `detected: false` included
(detect_image.py:567, unconditional). Only its four early returns write nothing:
budget_exhausted, no_brand, no_post and fetch_failed. So a post with zero
detection documents is a post whose media was never successfully analysed. That
is a fact in the data, not a counter, which is exactly why the resume reads it
instead of scan.detectTasksEnqueued.

WHAT IT CANNOT FIX, stated plainly because it bounds the whole feature.
Instagram and TikTok media URLs are short-lived signed CDN links, and
detect_image only stores the bytes of images it actually analysed
(detect_image.py:81-85). Media that was never analysed was never stored, so a
resume can only re-fetch what the CDN still serves. For a scan that stalled
hours ago most links are alive; for one that stalled last month almost none
are, and those posts will come back as fetch_failed however often this runs.
Re-enqueueing them is cheap (a failed fetch bills no Gemini call) but it is not
free of Firestore reads, hence the caps below.

Cost: no Apify at all — this republishes media already harvested. Gemini is
billed only for media that fetches, and the image-hash cache absorbs anything
that was in fact analysed under a different post id.
"""
from __future__ import annotations

import datetime as dt
import logging
from typing import Any

from google.cloud import pubsub_v1

from lib import fanout, fs, scan_state, usage

log = logging.getLogger(__name__)

PROJECT_ID = "brand-audit-4b2cc"
DETECT_IMAGE_TOPIC = "detect-image"
DETECT_VIDEO_TOPIC = "detect-video"

# How far back to look. A fortnight covers any stalled scan anybody is still
# looking at; beyond it the CDN links are dead and the reads are wasted.
DEFAULT_SINCE_DAYS = 14
# Ceilings, because this reads a subcollection per candidate post and a caller
# that names a year would spend real money on Firestore reads alone.
DEFAULT_MAX_POSTS = 400
HARD_MAX_POSTS = 2000


def run(
    brand_id: str,
    since_days: int = DEFAULT_SINCE_DAYS,
    max_posts: int = DEFAULT_MAX_POSTS,
    dry_run: bool = False,
) -> dict[str, Any]:
    brand = fs.brand_doc(brand_id).get()
    if not brand.exists:
        raise ValueError(f"brand not found: {brand_id}")

    # Same gates, same order as every other scraping path. A resume spends
    # Gemini, so the budget ladder governs it too.
    if usage.budget_exhausted(brand_id):
        return {"posts_checked": 0, "posts_without_analysis": 0, "images_enqueued": 0,
                "videos_enqueued": 0, "skipped": "budget_exhausted"}
    if not usage.scraping_allowed(brand_id):
        return {"posts_checked": 0, "posts_without_analysis": 0, "images_enqueued": 0,
                "videos_enqueued": 0, "skipped": "budget"}

    max_posts = max(1, min(int(max_posts or DEFAULT_MAX_POSTS), HARD_MAX_POSTS))
    since = dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=max(1, int(since_days or 1)))

    # Which posts already have a verdict of any kind. One range query, not one
    # query per post: at a few thousand rows that is the difference between a
    # second and a timeout.
    analysed: set[str] = set()
    for d in fs.detections_col(brand_id).where("postedAt", ">=", since).stream():
        pid = (d.to_dict() or {}).get("postId")
        if pid:
            analysed.add(str(pid))

    posts = list(
        fs.posts_col(brand_id)
        .where("postedAt", ">=", since)
        .limit(max_posts)
        .stream()
    )

    # (post_id, kind, url) — the same shape the scrapers hand to the fan-out.
    items: list[tuple[str, str, str]] = []
    without = 0
    for p in posts:
        if p.id in analysed:
            continue
        without += 1
        data = p.to_dict() or {}
        # The images subcollection is the authoritative media list; both
        # scan_creators and scan_stories write every frame into it.
        for img in fs.posts_col(brand_id).document(p.id).collection("images").stream():
            url = (img.to_dict() or {}).get("url")
            if url:
                items.append((p.id, "image", str(url)))
        video_url = data.get("videoUrl")
        if video_url:
            items.append((p.id, "video", str(video_url)))

    if dry_run:
        return {
            "posts_checked": len(posts),
            "posts_without_analysis": without,
            "images_enqueued": sum(1 for _, k, _ in items if k == "image"),
            "videos_enqueued": sum(1 for _, k, _ in items if k == "video"),
            "dry_run": True,
        }

    publisher = pubsub_v1.PublisherClient()
    images, videos, failed = fanout.publish_detect(
        publisher,
        publisher.topic_path(PROJECT_ID, DETECT_IMAGE_TOPIC),
        publisher.topic_path(PROJECT_ID, DETECT_VIDEO_TOPIC),
        brand_id,
        items,
    )

    # Only raise the denominator for messages that really landed, and only
    # while somebody is watching — the same rule the scrapers follow. A resume
    # run outside a session would otherwise inflate the totals of whatever
    # session last closed.
    if images + videos > 0 and scan_state.session_is_open(brand_id):
        scan_state.bump_enqueued(brand_id, images + videos)

    log.info(f"[{brand_id}] resume: {without} of {len(posts)} posts unanalysed, "
             f"{images} images + {videos} videos re-enqueued ({failed} failed)")
    return {
        "posts_checked": len(posts),
        "posts_without_analysis": without,
        "images_enqueued": images,
        "videos_enqueued": videos,
        "publish_failed": failed,
    }
