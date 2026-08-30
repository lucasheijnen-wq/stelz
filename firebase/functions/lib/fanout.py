"""Publishing detect work, and counting only what actually landed.

THE BUG THIS EXISTS FOR. All three scrape paths built the same loop: publish a
Pub/Sub message, increment a counter beside the publish call, collect the
future, and finally call `concurrent.futures.wait(futures, timeout=30)`. Not
one of them ever looked at a future again.

`wait()` does not raise and does not report. A future that finished by RAISING
lands in `done` with its exception silently held; a future still in flight when
the timeout expires lands in `not_done` and is abandoned. Either way the
counter had already been incremented, so `scan.detectTasksEnqueued` counted
publish ATTEMPTS while `scan.detectionsCompleted` counts messages that really
arrived. Every rejected or unflushed publish therefore left the analysis bar
permanently short — and short in a way that is indistinguishable on screen from
workers that died, which is how a scan came to report "de analyse-workers
schrijven al uren niets meer" about work that was never sent.

Three copies of the same eight lines carried the same defect, which is the
lesson tools/stelz_brand_watch/_fetch.py already records about four copies of a
downloader. So it lives here once.

Nothing here raises: a fan-out that cannot be counted must not take the scrape
that produced it down with it. The failures are logged and returned.
"""
from __future__ import annotations

import json
import logging
from typing import Any

log = logging.getLogger(__name__)

# How long to wait for the client to flush. Publishing is batched and local;
# anything still pending after this is not arriving in time to be counted.
FLUSH_TIMEOUT_S = 30


def count_landed(
    brand_id: str,
    pending: list[tuple[str, Any]],
    flush_timeout_s: float = FLUSH_TIMEOUT_S,
) -> tuple[int, int, int]:
    """Flush the publisher, then count the messages the broker actually took.

    `pending` is [(kind, future)] where kind is 'image' or 'video'; a None
    future means publish() itself raised. Returns (images, videos, failed).

    For callers whose publish sites are scattered through a long loop and
    cannot be reduced to one list of items — see scan_hashtags, which decides
    per post whether a cover ships alongside a video.
    """
    from concurrent.futures import wait as _fwait
    live = [f for _, f in pending if f is not None]
    if live:
        _fwait(live, timeout=flush_timeout_s)

    images = videos = failed = 0
    for kind, fut in pending:
        if fut is None:
            failed += 1
            continue
        try:
            # `not done()` is "still in flight when we stopped waiting".
            # exception() is the rejection wait() swallowed. Both mean no
            # message anybody may count on.
            if not fut.done() or fut.exception() is not None:
                failed += 1
                continue
        except Exception:
            failed += 1
            continue
        if kind == "video":
            videos += 1
        else:
            images += 1

    if failed:
        log.error(f"[{brand_id}] {failed} of {len(pending)} detect publishes did not land")
    return images, videos, failed


def publish_detect(
    publisher: Any,
    image_topic: str,
    video_topic: str,
    brand_id: str,
    items: list[tuple[str, str, str]],
    flush_timeout_s: float = FLUSH_TIMEOUT_S,
) -> tuple[int, int, int]:
    """Publish one detect message per item and report what LANDED.

    `items` is the (post_id, kind, url) shape all three scrapers already build,
    where kind is 'image' or 'video'.

    Returns (images_published, videos_published, failed). The first two are
    what may be added to scan.detectTasksEnqueued — they are messages the
    broker accepted, so a worker will eventually consume each one and bump the
    completion counter against it.
    """
    if not publisher or not items:
        return 0, 0, 0

    pending: list[tuple[str, Any]] = []
    for post_id, kind, url in items:
        payload: dict[str, Any] = {"brandId": brand_id, "postId": post_id}
        topic = video_topic if kind == "video" else image_topic
        payload["videoUrl" if kind == "video" else "imageUrl"] = url
        try:
            pending.append((kind, publisher.publish(topic, json.dumps(payload).encode())))
        except Exception as e:
            # publish() itself can raise before returning a future.
            log.error(f"[{brand_id}] publish raised for {post_id}: {e}")
            pending.append((kind, None))

    return count_landed(brand_id, pending, flush_timeout_s)
