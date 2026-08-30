"""The hashtag scan's completion contract — the step must always close.

This module went four commits without a single test importing it, and in those
four commits it lost its `scan_state` import: every path that closes the step
raised NameError at runtime. The success path swallowed it (bare except, AFTER
finishedAt was stamped) so `steps.hashtags` stayed "running" forever; the
budget path 500'd and aborted the dashboard's whole scan chain. What these
tests pin, in one sentence each:

  1. Budget-refused and empty-pool RETURN — graceful dicts, step closed by
     publish_tags itself, because no worker will ever exist to close it.
  2. The session reset lands BEFORE any tag message is published — a fast
     worker's Increment(1) must never be overwritten by the literal 0, or
     hashtagDone never converges and finishedAt is never stamped.
  3. The last worker stamps finishedAt AND closes the step; earlier workers do
     neither.
  4. The trim guard sizes the scan to today's REMAINING budget before a single
     Apify dollar is committed: halve per_tag first, then shrink max_tags with
     re-selection so the family stratification survives.
  5. A carousel child is persisted under the CHILD composite id — the identity
     both ingest paths now share.
"""
from __future__ import annotations

import os
import sys
import types
import unittest
from concurrent.futures import Future
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
for _attr, _val in (("SERVER_TIMESTAMP", "TS"),
                    ("Increment", lambda n: ("INC", n)),
                    ("ArrayUnion", lambda v: v), ("ArrayRemove", lambda v: v)):
    if not hasattr(_fsmod, _attr):
        setattr(_fsmod, _attr, _val)

from handlers import scan_hashtags  # noqa: E402
from lib import usage as usage_real  # noqa: E402  (COST_PER_UNIT price only)

RESULT_USD = usage_real.COST_PER_UNIT["apify_ig_results"]


class FakeSnap:
    def __init__(self, data, exists=True):
        self._d = data
        self.exists = exists

    def to_dict(self):
        return dict(self._d)


class FakeBrandDoc:
    """Records every set(); serves a mutable dict as the brand snapshot."""

    def __init__(self, events, data=None):
        self._events = events
        self.data = data if data is not None else {}

    def get(self):
        return FakeSnap(self.data)

    def set(self, payload, merge=False):
        self._events.append(("set", payload))

    def update(self, payload):
        self._events.append(("update", payload))


class FakePoolDoc:
    def __init__(self, d):
        self._d = d

    def to_dict(self):
        return dict(self._d)


class FakePublisher:
    def __init__(self, events):
        self._events = events

    def topic_path(self, project, topic):
        return f"{project}/{topic}"

    def publish(self, topic, payload):
        self._events.append(("publish", topic, payload))
        f = Future()
        f.set_result("msg-id")
        return f


def pool_of(n):
    return [FakePoolDoc({"tag": f"tag{i:02d}", "platform": "instagram",
                         "family": "brand_core", "priority": 1, "active": True})
            for i in range(n)]


class PublishTagsBase(unittest.TestCase):
    def setUp(self):
        self.events: list = []
        self.brand = FakeBrandDoc(self.events)
        self.pool: list = []
        self.steps_closed: list = []
        self.degrade = usage_real.DEGRADE_NORMAL
        self.remaining = float("inf")

        fake_fs = types.SimpleNamespace(
            brand_doc=lambda bid: self.brand,
            hashtag_pool_col=lambda bid: types.SimpleNamespace(
                where=lambda *a: types.SimpleNamespace(stream=lambda: iter(self.pool))),
        )
        fake_usage = types.SimpleNamespace(
            degrade_level=lambda bid: self.degrade,
            remaining_budget_usd=lambda bid: self.remaining,
            COST_PER_UNIT=usage_real.COST_PER_UNIT,
            DEGRADE_NO_SCRAPE=usage_real.DEGRADE_NO_SCRAPE,
            DEGRADE_TRIM=usage_real.DEGRADE_TRIM,
        )
        fake_scan_state = types.SimpleNamespace(
            step_finished=lambda bid, step, counts=None:
                self.steps_closed.append((step, counts)),
        )
        fake_pubsub = types.SimpleNamespace(
            PublisherClient=lambda: FakePublisher(self.events))
        for target, repl in (("fs", fake_fs), ("usage", fake_usage),
                             ("scan_state", fake_scan_state),
                             ("pubsub_v1", fake_pubsub)):
            p = mock.patch.object(scan_hashtags, target, repl)
            p.start()
            self.addCleanup(p.stop)


class TestGracefulPaths(PublishTagsBase):
    def test_budget_refused_returns_and_closes_the_step(self):
        # This exact path raised NameError for four commits: HTTP 500, and the
        # dashboard's entire scan chain (stories/creators/profielen/…) aborted.
        self.degrade = usage_real.DEGRADE_NO_SCRAPE
        out = scan_hashtags.publish_tags("stelz")
        self.assertEqual(out["skipped"], "budget")
        self.assertEqual(out["queued"], 0)
        self.assertEqual([s for s, _ in self.steps_closed], ["hashtags"])
        self.assertFalse([e for e in self.events if e[0] == "publish"])

    def test_empty_pool_returns_and_closes_the_step(self):
        self.pool = []
        out = scan_hashtags.publish_tags("stelz")
        self.assertEqual(out["queued"], 0)
        self.assertEqual([s for s, _ in self.steps_closed], ["hashtags"])


class TestResetBeforePublish(PublishTagsBase):
    def test_session_zeroes_land_before_the_first_publish(self):
        # The reset used to run AFTER the publishes: a tag worker finishing
        # inside that window had its Increment(1) overwritten by the literal 0,
        # hashtagDone never reached hashtagQueued, finishedAt never came.
        self.pool = pool_of(3)
        out = scan_hashtags.publish_tags("stelz", per_tag=50, max_tags=10)
        self.assertEqual(out["queued"], 3)
        kinds = []
        for e in self.events:
            if e[0] == "publish":
                kinds.append("publish")
            elif e[0] == "set" and (e[1].get("scan") or {}).get("hashtagDone") == 0:
                kinds.append("reset")
        self.assertIn("reset", kinds)
        self.assertIn("publish", kinds)
        self.assertLess(kinds.index("reset"), kinds.index("publish"),
                        "de sessie-reset moet vóór elke publish liggen")
        # The denominator the reset writes is the number actually queued.
        reset = next(e[1]["scan"] for e in self.events
                     if e[0] == "set" and (e[1].get("scan") or {}).get("hashtagDone") == 0)
        self.assertEqual(reset["hashtagQueued"], 3)


class TestBudgetTrim(PublishTagsBase):
    def test_trims_depth_first_then_breadth_to_fit_remaining_budget(self):
        self.pool = pool_of(40)
        self.remaining = 2.0   # APIFY_SHARE halves this to $1.00 of Apify room
        out = scan_hashtags.publish_tags("stelz", per_tag=500, max_tags=40)
        self.assertTrue(out["trimmed"])
        published = [e for e in self.events if e[0] == "publish"]
        self.assertEqual(len(published), out["queued"])
        self.assertLess(out["queued"], 40, "breedte moet gekrompen zijn")
        import json as _json
        per_tags = {_json.loads(p[2].decode())["perTag"] for p in published}
        self.assertEqual(per_tags, {30}, "diepte hoort op de vloer te staan")
        self.assertLessEqual(out["projectedResults"] * RESULT_USD, 1.0 + 1e-9)

    def test_no_trim_when_budget_is_ample(self):
        self.pool = pool_of(3)
        out = scan_hashtags.publish_tags("stelz", per_tag=50, max_tags=10)
        self.assertFalse(out["trimmed"])
        self.assertEqual(out["queued"], 3)


class TestMarkTagDone(PublishTagsBase):
    """Closing the hashtag phase — the write that could half-land.

    It used to be two writes: scan.finishedAt first, then a separate
    step_finished. Both failures are swallowed, so a transient Firestore error
    or the 540s container deadline landing between them left steps.hashtags on
    'running' with finishedAt already set. And the guard was `not finishedAt`
    alone, which made that PERMANENT — every later worker and every Pub/Sub
    redelivery found finishedAt set and skipped the close, and scan_watchdog
    was removed (main.py:70), so nothing repaired it server-side. The panel
    then pulsed for six hours before the client relabelled the row red.
    """

    def closes(self):
        """Every write that closes the session, whichever API it used."""
        return [e for e in self.events
                if (e[0] == "update" and e[1].get("scan.endReason"))
                or (e[0] == "set" and (e[1].get("scan") or {}).get("endReason"))]

    def test_last_worker_stamps_finished_and_closes_the_step(self):
        self.brand.data = {"scan": {"hashtagDone": 2, "hashtagQueued": 2,
                                    "finishedAt": None, "postsWritten": 7,
                                    "detectTasksEnqueued": 5}}
        scan_hashtags._mark_tag_done("stelz", posts_written=3, detect_tasks=2)
        finish = self.closes()
        self.assertEqual(len(finish), 1)
        self.assertEqual(finish[0][1]["scan.endReason"], "tags_complete")
        # THE line that was dead for four commits: the step actually closes.
        self.assertEqual(finish[0][1]["scan.steps.hashtags.state"], "done")

    def test_the_close_is_one_atomic_write(self):
        """A Firestore document write is atomic; two are not. Splitting these
        is what let the step hang 'running' under a finished session."""
        self.brand.data = {"scan": {"hashtagDone": 1, "hashtagQueued": 1,
                                    "finishedAt": None}}
        scan_hashtags._mark_tag_done("stelz")
        finish = self.closes()
        self.assertEqual(len(finish), 1, "the close must not be split in two")
        payload = finish[0][1]
        self.assertIn("scan.finishedAt", payload)
        self.assertIn("scan.steps.hashtags.state", payload)

    def test_a_step_left_running_is_repaired_by_a_later_worker(self):
        """The unrecoverable state, made recoverable. finishedAt is already
        set from a close whose second write was lost; a redelivered or later
        worker must finish the job rather than skip it forever."""
        self.brand.data = {"scan": {
            "hashtagDone": 2, "hashtagQueued": 2, "finishedAt": "eerder",
            "steps": {"hashtags": {"state": "running"}},
        }}
        scan_hashtags._mark_tag_done("stelz")
        finish = self.closes()
        self.assertEqual(len(finish), 1)
        self.assertEqual(finish[0][1]["scan.steps.hashtags.state"], "done")

    def test_a_finished_session_is_not_reclosed(self):
        """Only the broken state is repaired. Re-closing a healthy finished
        session would move finishedAt forward on every stray redelivery."""
        self.brand.data = {"scan": {
            "hashtagDone": 2, "hashtagQueued": 2, "finishedAt": "eerder",
            "steps": {"hashtags": {"state": "done"}},
        }}
        scan_hashtags._mark_tag_done("stelz")
        self.assertEqual(self.closes(), [])

    def test_not_last_worker_neither_stamps_nor_closes(self):
        self.brand.data = {"scan": {"hashtagDone": 1, "hashtagQueued": 2,
                                    "finishedAt": None}}
        scan_hashtags._mark_tag_done("stelz")
        self.assertEqual(self.closes(), [])
        self.assertEqual(self.steps_closed, [])


class TestSidecarChildIds(unittest.TestCase):
    def test_child_persists_under_the_child_composite_id(self):
        # The identity both ingest paths now share: the same slide must land on
        # the same post id whether it arrived via #stelz or via the profile
        # deep-scan, or the two produce two detection docs for one image.
        writes: dict[str, dict] = {}

        class Col:
            def document(self, doc_id):
                col = self

                class Doc:
                    def set(self, payload, merge=False):
                        writes[doc_id] = payload
                        _ = col
                return Doc()

        from lib import fs as fs_real
        parent = {"id": "P123", "caption": "hi", "hashtags": ["stelz"],
                  "timestamp": "2026-08-22T10:00:00Z", "url": "u"}
        child = {"id": "C9", "displayUrl": "http://img", "order": 2}
        post_id, kind, url, cover = scan_hashtags._persist_sidecar_child(
            "stelz", parent, child, "anna", Col())
        self.assertEqual(post_id, fs_real.composite_id("instagram", "P123_C9"))
        self.assertEqual(kind, "image")
        self.assertEqual(url, "http://img")
        self.assertIsNone(cover)
        self.assertEqual(writes[post_id]["parentPostId"], "P123")

    def test_every_slide_of_a_carousel_shares_the_parents_key(self):
        """The metrics on a slide are the PARENT'S, copied down so a slide can
        show its post's numbers. Counted per row that turned a ten-slide
        carousel with 500 likes into 5.000: the rollup keys on postKey, and a
        slide whose postKey was null fell back to its own doc id, which is
        unique per slide. One key per carousel is what collapses them."""
        writes: dict[str, dict] = {}

        class Col:
            def document(self, doc_id):
                class Doc:
                    def set(self, payload, merge=False):
                        writes[doc_id] = payload
                return Doc()

        parent = {"id": "P123", "shortCode": "DaBcDeF", "caption": "hi",
                  "hashtags": [], "timestamp": "2026-08-22T10:00:00Z",
                  "url": "u", "likesCount": 500}
        ids = [scan_hashtags._persist_sidecar_child(
            "stelz", parent, {"id": f"C{i}", "displayUrl": "http://img", "order": i},
            "anna", Col())[0] for i in range(3)]

        self.assertEqual(len(set(ids)), 3, "slides stay separate documents — "
                                          "each one has its own image to show")
        keys = {writes[i]["postKey"] for i in ids}
        self.assertEqual(keys, {"dabcdef"}, "but they count as one post")
        self.assertEqual([writes[i]["slot"] for i in ids], [0, 1, 2])

    def test_a_missing_parent_count_is_not_written_as_zero(self):
        writes: dict[str, dict] = {}

        class Col:
            def document(self, doc_id):
                class Doc:
                    def set(self, payload, merge=False):
                        writes[doc_id] = payload
                return Doc()

        parent = {"id": "P1", "shortCode": "AAA", "caption": "", "hashtags": [],
                  "timestamp": "2026-08-22T10:00:00Z", "url": "u"}
        pid, *_ = scan_hashtags._persist_sidecar_child(
            "stelz", parent, {"id": "C1", "displayUrl": "http://img"}, "anna", Col())
        self.assertIsNone(writes[pid]["likesCount"])
        self.assertIsNone(writes[pid]["viewsCount"])


if __name__ == "__main__":
    unittest.main()
