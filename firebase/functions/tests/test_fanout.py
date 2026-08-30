"""Counting detect messages that actually landed.

THE BUG. All three scrape paths incremented scan.detectTasksEnqueued beside
the publish() call and then called concurrent.futures.wait(futures, timeout=N)
without ever inspecting a future. wait() holds a raised exception silently and
abandons anything still pending at the timeout, so a rejected or unflushed
publish still raised the denominator. The analysis bar was then permanently
short by messages that never existed — and short in a way that looks exactly
like workers dying, which is how a scan came to report "de analyse-workers
schrijven al uren niets meer" about work nobody ever sent.

These tests are all about the difference between "we called publish" and "a
message exists". Nothing here touches Pub/Sub.
"""
from __future__ import annotations

import json
import os
import sys
import unittest
from concurrent.futures import Future

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib import fanout  # noqa: E402


def ok_future(value: str = "msg-id") -> Future:
    f: Future = Future()
    f.set_result(value)
    return f


def failed_future(exc: Exception | None = None) -> Future:
    f: Future = Future()
    f.set_exception(exc or RuntimeError("topic not found"))
    return f


def pending_future() -> Future:
    """Never resolves — the "still in flight when we gave up" case."""
    return Future()


class FakePublisher:
    """Returns futures from a script, and records what it was asked to send."""

    def __init__(self, script=None):
        self.script = list(script or [])
        self.sent: list[tuple[str, dict]] = []

    def publish(self, topic, data):
        self.sent.append((topic, json.loads(data.decode())))
        if self.script:
            nxt = self.script.pop(0)
            if isinstance(nxt, Exception):
                raise nxt
            return nxt
        return ok_future()


ITEMS = [
    ("instagram_1", "image", "http://x/a.jpg"),
    ("instagram_2", "video", "http://x/b.mp4"),
]


class TestPublishDetect(unittest.TestCase):
    def test_a_clean_run_counts_every_message(self):
        p = FakePublisher()
        imgs, vids, failed = fanout.publish_detect(p, "img", "vid", "stelz", ITEMS)
        self.assertEqual((imgs, vids, failed), (1, 1, 0))

    def test_the_payload_shape_is_unchanged(self):
        # The workers read brandId/postId plus exactly one media key; changing
        # that here would silently stop every detection.
        p = FakePublisher()
        fanout.publish_detect(p, "img", "vid", "stelz", ITEMS)
        topics = [t for t, _ in p.sent]
        self.assertEqual(topics, ["img", "vid"])
        self.assertEqual(p.sent[0][1], {
            "brandId": "stelz", "postId": "instagram_1", "imageUrl": "http://x/a.jpg"})
        self.assertEqual(p.sent[1][1], {
            "brandId": "stelz", "postId": "instagram_2", "videoUrl": "http://x/b.mp4"})

    def test_a_rejected_publish_is_not_counted(self):
        # wait() puts this future in `done` and discards the exception — which
        # is exactly why the old code never noticed.
        p = FakePublisher([failed_future(), ok_future()])
        imgs, vids, failed = fanout.publish_detect(p, "img", "vid", "stelz", ITEMS)
        self.assertEqual((imgs, vids, failed), (0, 1, 1))

    def test_a_publish_still_in_flight_is_not_counted(self):
        p = FakePublisher([pending_future(), ok_future()])
        imgs, vids, failed = fanout.publish_detect(
            p, "img", "vid", "stelz", ITEMS, flush_timeout_s=0.01)
        self.assertEqual((imgs, vids, failed), (0, 1, 1))

    def test_publish_raising_outright_is_not_counted_and_does_not_propagate(self):
        # A fan-out that cannot be counted must not take the scrape that
        # produced it down with it — the posts are already on disk.
        p = FakePublisher([RuntimeError("client closed"), ok_future()])
        imgs, vids, failed = fanout.publish_detect(p, "img", "vid", "stelz", ITEMS)
        self.assertEqual((imgs, vids, failed), (0, 1, 1))

    def test_no_publisher_is_a_no_op(self):
        self.assertEqual(fanout.publish_detect(None, "img", "vid", "stelz", ITEMS), (0, 0, 0))

    def test_no_items_is_a_no_op(self):
        p = FakePublisher()
        self.assertEqual(fanout.publish_detect(p, "img", "vid", "stelz", []), (0, 0, 0))
        self.assertEqual(p.sent, [])

    def test_the_guard_above_can_actually_fail(self):
        """Prove the fixture can distinguish the two outcomes at all — a
        counter that always reported the attempt count would pass every test
        above except this contrast."""
        p = FakePublisher([failed_future(), failed_future()])
        imgs, vids, failed = fanout.publish_detect(p, "img", "vid", "stelz", ITEMS)
        self.assertEqual((imgs, vids), (0, 0))
        self.assertEqual(failed, len(ITEMS))


class TestCountLanded(unittest.TestCase):
    """The scattered-call-site variant, for scan_hashtags — which decides per
    post whether a cover ships alongside a video and so cannot hand over one
    flat list of items."""

    def test_counts_by_kind(self):
        pending = [("image", ok_future()), ("video", ok_future()), ("image", ok_future())]
        self.assertEqual(fanout.count_landed("stelz", pending), (2, 1, 0))

    def test_a_none_future_means_publish_raised(self):
        pending = [("image", None), ("video", ok_future())]
        self.assertEqual(fanout.count_landed("stelz", pending), (0, 1, 1))

    def test_mixed_success_and_failure(self):
        pending = [
            ("image", ok_future()), ("image", failed_future()),
            ("video", ok_future()), ("video", pending_future()),
        ]
        self.assertEqual(
            fanout.count_landed("stelz", pending, flush_timeout_s=0.01), (1, 1, 2))

    def test_empty_is_zero(self):
        self.assertEqual(fanout.count_landed("stelz", []), (0, 0, 0))

    def test_an_unknown_kind_counts_as_an_image(self):
        # Only two topics exist; anything not explicitly 'video' goes to the
        # image side, matching the publish branch it came from.
        self.assertEqual(fanout.count_landed("stelz", [("", ok_future())]), (1, 0, 0))


if __name__ == "__main__":
    unittest.main(verbosity=2)
