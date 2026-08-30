"""Resuming analysis for media that never produced a verdict.

WHY THE GAP IS READ FROM THE DATA AND NOT THE COUNTER. scan.detectTasksEnqueued
counts publish ATTEMPTS and scan.detectionsCompleted is 9,573 separate
Increment(1) writes to one document — neither can name a file. detect_image
writes a detection document on every completed analysis including a miss
(detect_image.py:567, unconditional), and only its four early returns write
nothing, so "a post with no detection document" is a fact about work rather
than about bookkeeping. That is what this handler reads.

WHAT IT CANNOT DO, pinned here so nobody later mistakes the feature for more
than it is: media whose signed CDN link has expired cannot be re-fetched, and
was never stored because only analysed images are uploaded. Those posts come
back as fetch_failed however often this runs.
"""
from __future__ import annotations

import datetime as dt
import os
import sys
import types
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _stub(name: str) -> types.ModuleType:
    mod = sys.modules.get(name)
    if mod is None:
        mod = types.ModuleType(name)
        sys.modules[name] = mod
    if "." in name:
        parent, _, child = name.rpartition(".")
        setattr(_stub(parent), child, mod)
    return mod


for _n in (
    "firebase_admin", "firebase_admin.firestore", "firebase_admin.storage",
    "google.cloud", "google.cloud.firestore", "google.cloud.pubsub_v1",
):
    _stub(_n)
_stub("firebase_admin").initialize_app = lambda *a, **k: None
_stub("firebase_admin").get_app = lambda *a, **k: None
_stub("firebase_admin").credentials = types.SimpleNamespace(ApplicationDefault=lambda: None)
_fsmod = _stub("google.cloud.firestore")
for _a, _v in (("SERVER_TIMESTAMP", "TS"), ("Increment", lambda *a, **k: None),
               ("ArrayUnion", lambda v: v), ("ArrayRemove", lambda v: v)):
    if not hasattr(_fsmod, _a):
        setattr(_fsmod, _a, _v)

from handlers import resume_analysis  # noqa: E402

PAST = dt.datetime(2026, 8, 25, tzinfo=dt.timezone.utc)


class Snap:
    def __init__(self, doc_id, data):
        self.id = doc_id
        self._d = dict(data)

    def to_dict(self):
        return dict(self._d)


class Query:
    """where(...).limit(n).stream() over a list, ignoring the predicate — the
    window filter is Firestore's job and is not what these tests pin."""

    def __init__(self, rows, cap=None):
        self._rows, self._cap = rows, cap

    def where(self, *a, **k):
        return self

    def limit(self, n):
        return Query(self._rows, n)

    def stream(self):
        return list(self._rows)[: self._cap] if self._cap else list(self._rows)


class PostsCol(Query):
    def __init__(self, rows, images):
        super().__init__(rows)
        self._images = images

    def limit(self, n):
        q = PostsCol(self._rows, self._images)
        q._cap = n
        return q

    def document(self, doc_id):
        imgs = self._images.get(doc_id, [])
        return types.SimpleNamespace(
            collection=lambda name: Query([Snap(f"{doc_id}_{i}", im)
                                           for i, im in enumerate(imgs)]))


class Base(unittest.TestCase):
    def setUp(self):
        self.posts: list[Snap] = []
        self.detections: list[Snap] = []
        self.images: dict[str, list[dict]] = {}
        self.published: list[tuple[str, str, str]] = []
        self.enqueued: list[int] = []
        self.session_open = True

        fake_fs = types.SimpleNamespace(
            brand_doc=lambda bid: mock.Mock(get=lambda: mock.Mock(exists=True)),
            posts_col=lambda bid: PostsCol(self.posts, self.images),
            detections_col=lambda bid: Query(self.detections),
        )
        self.usage = types.SimpleNamespace(
            budget_exhausted=lambda bid: False,
            scraping_allowed=lambda bid: True,
        )

        def fake_publish(publisher, itopic, vtopic, bid, items, **kw):
            self.published.extend(items)
            return (sum(1 for _, k, _ in items if k == "image"),
                    sum(1 for _, k, _ in items if k == "video"), 0)

        for p in (
            mock.patch.object(resume_analysis, "fs", fake_fs),
            mock.patch.object(resume_analysis, "usage", self.usage),
            mock.patch.object(resume_analysis, "fanout",
                              types.SimpleNamespace(publish_detect=fake_publish)),
            mock.patch.object(resume_analysis, "scan_state", types.SimpleNamespace(
                session_is_open=lambda bid: self.session_open,
                bump_enqueued=lambda bid, n: self.enqueued.append(n))),
            mock.patch.object(resume_analysis, "pubsub_v1", types.SimpleNamespace(
                PublisherClient=lambda: types.SimpleNamespace(
                    topic_path=lambda a, b: f"{a}/{b}"))),
        ):
            p.start()
            self.addCleanup(p.stop)

    def add_post(self, pid, images=(), video_url=None, analysed=False):
        self.posts.append(Snap(pid, {"videoUrl": video_url} if video_url else {}))
        self.images[pid] = [{"url": u} for u in images]
        if analysed:
            self.detections.append(Snap(f"det_{pid}", {"postId": pid}))


class TestFindsTheGap(Base):
    def test_a_post_with_no_detection_is_re_enqueued(self):
        self.add_post("p1", images=["http://x/1.jpg"], analysed=False)
        out = resume_analysis.run("stelz")
        self.assertEqual(out["posts_without_analysis"], 1)
        self.assertEqual(self.published, [("p1", "image", "http://x/1.jpg")])

    def test_a_post_that_was_analysed_is_left_alone(self):
        self.add_post("p1", images=["http://x/1.jpg"], analysed=True)
        out = resume_analysis.run("stelz")
        self.assertEqual(out["posts_without_analysis"], 0)
        self.assertEqual(self.published, [])

    def test_a_MISS_counts_as_analysed(self):
        """detect_image writes a detection document for a miss too, which is
        the whole reason this check is trustworthy. Re-analysing every post
        that produced no HIT would redo almost the entire archive at full
        Gemini price."""
        self.add_post("p1", images=["http://x/1.jpg"])
        self.detections.append(Snap("det_p1", {"postId": "p1", "detected": False}))
        out = resume_analysis.run("stelz")
        self.assertEqual(out["posts_without_analysis"], 0)
        self.assertEqual(self.published, [])

    def test_video_and_cover_both_go_back(self):
        # The cover is the pass that reliably succeeds when a video URL has
        # expired, so a resume that sent only the video would recover less.
        self.add_post("p1", images=["http://x/cover.jpg"], video_url="http://x/v.mp4")
        resume_analysis.run("stelz")
        self.assertEqual(self.published, [
            ("p1", "image", "http://x/cover.jpg"),
            ("p1", "video", "http://x/v.mp4"),
        ])

    def test_every_slide_of_a_carousel_goes_back(self):
        self.add_post("p1", images=["http://x/1.jpg", "http://x/2.jpg", "http://x/3.jpg"])
        out = resume_analysis.run("stelz")
        self.assertEqual(out["images_enqueued"], 3)

    def test_a_post_with_no_media_at_all_publishes_nothing(self):
        self.add_post("p1", images=[])
        out = resume_analysis.run("stelz")
        self.assertEqual(out["posts_without_analysis"], 1)
        self.assertEqual(self.published, [])

    def test_mixed_archive(self):
        self.add_post("done1", images=["http://x/a.jpg"], analysed=True)
        self.add_post("gap1", images=["http://x/b.jpg"])
        self.add_post("done2", images=["http://x/c.jpg"], analysed=True)
        self.add_post("gap2", images=["http://x/d.jpg"])
        out = resume_analysis.run("stelz")
        self.assertEqual(out["posts_checked"], 4)
        self.assertEqual(out["posts_without_analysis"], 2)
        self.assertEqual([p for p, _, _ in self.published], ["gap1", "gap2"])


class TestGuards(Base):
    def test_budget_exhausted_publishes_nothing(self):
        self.add_post("p1", images=["http://x/1.jpg"])
        self.usage.budget_exhausted = lambda bid: True
        out = resume_analysis.run("stelz")
        self.assertEqual(out["skipped"], "budget_exhausted")
        self.assertEqual(self.published, [])

    def test_the_degrade_rung_also_stops_it(self):
        self.add_post("p1", images=["http://x/1.jpg"])
        self.usage.scraping_allowed = lambda bid: False
        out = resume_analysis.run("stelz")
        self.assertEqual(out["skipped"], "budget")
        self.assertEqual(self.published, [])

    def test_dry_run_reports_without_publishing(self):
        self.add_post("p1", images=["http://x/1.jpg"], video_url="http://x/v.mp4")
        out = resume_analysis.run("stelz", dry_run=True)
        self.assertTrue(out["dry_run"])
        self.assertEqual(out["images_enqueued"], 1)
        self.assertEqual(out["videos_enqueued"], 1)
        self.assertEqual(self.published, [])

    def test_max_posts_is_clamped_to_the_hard_ceiling(self):
        # This reads a subcollection per candidate post, so an unbounded
        # caller costs real money in Firestore reads alone.
        for i in range(5):
            self.add_post(f"p{i}", images=[f"http://x/{i}.jpg"])
        out = resume_analysis.run("stelz", max_posts=10_000_000)
        self.assertLessEqual(out["posts_checked"], resume_analysis.HARD_MAX_POSTS)

    def test_max_posts_caps_the_query(self):
        for i in range(10):
            self.add_post(f"p{i}", images=[f"http://x/{i}.jpg"])
        out = resume_analysis.run("stelz", max_posts=3)
        self.assertEqual(out["posts_checked"], 3)


class TestDenominator(Base):
    def test_the_denominator_grows_by_what_landed(self):
        self.add_post("p1", images=["http://x/1.jpg", "http://x/2.jpg"])
        resume_analysis.run("stelz")
        self.assertEqual(self.enqueued, [2])

    def test_no_open_session_means_no_bump(self):
        """A resume run outside a session would otherwise inflate the totals
        of whatever session last closed — the same rule the scrapers follow."""
        self.session_open = False
        self.add_post("p1", images=["http://x/1.jpg"])
        resume_analysis.run("stelz")
        self.assertEqual(self.enqueued, [])
        self.assertEqual(len(self.published), 1, "the work still goes out")

    def test_nothing_to_do_bumps_nothing(self):
        self.add_post("p1", images=["http://x/1.jpg"], analysed=True)
        resume_analysis.run("stelz")
        self.assertEqual(self.enqueued, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
