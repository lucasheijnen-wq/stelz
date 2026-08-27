"""Creator scan — the selection filter and the budget accounting.

Two behaviours here are load-bearing:

1. THE BILLING LINE. scan_creators used to record only apify_runs, which costs
   $0.00 in COST_PER_UNIT — every dollar of Instagram scraping it did was
   invisible to the budget ladder, including to its own budget guard. The
   billed unit is apify_ig_results and it must be recorded.

2. THE INEQUALITY FILTER. Selection is `nextScanAt <= now`; Firestore excludes
   docs that lack the field entirely. A creator stub written without nextScanAt
   is therefore invisible to the scanner forever — which is why projects.py
   puts the stamp in the stub write itself, and why the fake here reproduces
   the real exclusion semantics instead of treating missing as due.
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
if not hasattr(_fsmod, "SERVER_TIMESTAMP"):
    _fsmod.SERVER_TIMESTAMP = "TS"
if not hasattr(_fsmod, "Increment"):
    _fsmod.Increment = lambda *a, **k: None
if not hasattr(_fsmod, "ArrayUnion"):
    _fsmod.ArrayUnion = lambda v: v
if not hasattr(_fsmod, "ArrayRemove"):
    _fsmod.ArrayRemove = lambda v: v

from handlers import scan_creators  # noqa: E402


# ── In-memory creators query with REAL inequality semantics ─────────────

class FakeCreatorSnap:
    def __init__(self, doc_id, data, exists=True):
        self.id = doc_id
        self._d = dict(data)
        self.exists = exists
        self.reference = mock.Mock()

    def to_dict(self):
        return dict(self._d)


class FakeCreatorsQuery:
    """Chained .where().where().limit().stream() over a dict store.

    Mirrors what production relies on: `in` on status, `<=` on nextScanAt, and
    Firestore's rule that an inequality EXCLUDES docs missing the field."""

    def __init__(self, store, filters=None, cap=None):
        self._store = store
        self._filters = list(filters or [])
        self._cap = cap

    def where(self, field, op, value):
        return FakeCreatorsQuery(self._store, self._filters + [(field, op, value)], self._cap)

    def limit(self, n):
        return FakeCreatorsQuery(self._store, self._filters, n)

    def document(self, doc_id):
        """A ref is just its id here — get_all below resolves it."""
        return types.SimpleNamespace(id=doc_id)

    def stream(self):
        out = []
        for doc_id, d in self._store.items():
            ok = True
            for field, op, value in self._filters:
                if op == "in":
                    ok = d.get(field) in value
                elif op == "<=":
                    ok = field in d and d[field] <= value
                else:
                    raise AssertionError(f"unexpected op {op}")
                if not ok:
                    break
            if ok:
                out.append(FakeCreatorSnap(doc_id, d))
        return out[: self._cap] if self._cap else out


PAST = dt.datetime(2026, 8, 19, tzinfo=dt.timezone.utc)


class ScanCreatorsBase(unittest.TestCase):
    def setUp(self):
        self.creators: dict = {}
        self.recorded: list[dict] = []

        fake_fs = types.SimpleNamespace(
            brand_doc=lambda bid: mock.Mock(get=lambda: mock.Mock(exists=True)),
            creators_col=lambda bid: FakeCreatorsQuery(self.creators),
            posts_col=lambda bid: mock.Mock(),
            scan_runs_col=lambda bid: mock.Mock(add=lambda d: None),
            # get_all resolves refs by id and reports missing docs as
            # exists=False — the real client's behaviour, and the reason the
            # named-set path filters on it rather than assuming every id is real.
            db=lambda: types.SimpleNamespace(get_all=lambda refs: [
                FakeCreatorSnap(r.id, self.creators[r.id]) if r.id in self.creators
                else FakeCreatorSnap(r.id, {}, exists=False)
                for r in refs
            ]),
        )
        self.usage = types.SimpleNamespace(
            budget_exhausted=lambda bid: False,
            scraping_allowed=lambda bid: True,
            record=lambda bid, **kw: self.recorded.append(kw),
        )
        self.apify = mock.Mock()
        self.apify.scrape_profile_ig = mock.Mock(return_value=[])
        self.apify.run_sync = mock.Mock(return_value=[])

        patches = [
            mock.patch.object(scan_creators, "fs", fake_fs),
            mock.patch.object(scan_creators, "usage", self.usage),
            mock.patch.object(scan_creators, "apify", self.apify),
            # Persistence is scan-pipeline plumbing, not what these tests pin.
            mock.patch.object(scan_creators, "_persist_post", lambda *a, **k: None),
            mock.patch.object(scan_creators, "_audit_creators_scrape", lambda *a, **k: None),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def run_scan(self, **kw):
        return scan_creators.run("stelz", dry_run=True, **kw)


class TestBillingIsRecorded(ScanCreatorsBase):
    def test_ig_results_are_recorded_as_the_billed_unit(self):
        # The bug this pins: only apify_runs (cost $0.00) was recorded, so IG
        # creator-scan spend never reached the budget ladder.
        self.creators["instagram_anna"] = {
            "status": "discovered", "platform": "instagram", "handle": "anna", "nextScanAt": PAST,
        }
        self.apify.scrape_profile_ig.return_value = [{"id": str(i)} for i in range(5)]
        self.run_scan()
        self.assertEqual(len(self.recorded), 1)
        self.assertEqual(self.recorded[0].get("apify_ig_results"), 5)
        self.assertEqual(self.recorded[0].get("apify_runs"), 1)
        self.assertEqual(self.recorded[0].get("apify_tt_results"), 0)

    def test_tiktok_results_are_recorded_too(self):
        self.creators["tiktok_carla"] = {
            "status": "discovered", "platform": "tiktok", "handle": "carla", "nextScanAt": PAST,
        }
        self.apify.run_sync.return_value = [{"id": str(i)} for i in range(3)]
        self.run_scan()
        self.assertEqual(self.recorded[0].get("apify_tt_results"), 3)
        self.assertEqual(self.recorded[0].get("apify_ig_results"), 0)


class TestBudgetGates(ScanCreatorsBase):
    def test_scraping_disallowed_skips_without_touching_apify(self):
        # The 95% degrade rung: before this gate the creator scan kept scraping
        # at full width until the budget was fully blown.
        self.creators["instagram_anna"] = {
            "status": "discovered", "platform": "instagram", "handle": "anna", "nextScanAt": PAST,
        }
        self.usage.scraping_allowed = lambda bid: False
        out = self.run_scan()
        self.assertEqual(out.get("skipped"), "budget")
        self.apify.scrape_profile_ig.assert_not_called()
        self.apify.run_sync.assert_not_called()

    def test_budget_exhausted_skip_is_preserved(self):
        self.usage.budget_exhausted = lambda bid: True
        out = self.run_scan()
        self.assertEqual(out.get("skipped"), "budget_exhausted")
        self.apify.scrape_profile_ig.assert_not_called()


class TestSelection(ScanCreatorsBase):
    def test_discovered_status_is_selected(self):
        # The projects import path creates stubs with exactly this status; the
        # whole feature rests on the scanner picking them up.
        self.creators["instagram_stub"] = {
            "status": "discovered", "platform": "instagram", "handle": "stub", "nextScanAt": PAST,
        }
        out = self.run_scan()
        self.assertEqual(out["creators_scanned"], 1)

    def test_doc_without_next_scan_at_is_never_selected(self):
        # Firestore inequality semantics: missing field = excluded. This is why
        # the stub write carries nextScanAt itself.
        self.creators["instagram_ghost"] = {
            "status": "discovered", "platform": "instagram", "handle": "ghost",
        }
        out = self.run_scan()
        self.assertEqual(out["creators_scanned"], 0)
        self.apify.scrape_profile_ig.assert_not_called()

    def test_future_next_scan_at_is_not_due(self):
        self.creators["instagram_late"] = {
            "status": "discovered", "platform": "instagram", "handle": "late",
            "nextScanAt": dt.datetime.now(dt.timezone.utc) + dt.timedelta(hours=6),
        }
        out = self.run_scan()
        self.assertEqual(out["creators_scanned"], 0)


class TestCarouselChildIds(unittest.TestCase):
    """The deep-scan must land a slide on the SAME post id as the hashtag path.

    It used to fan every slide out under the PARENT id while scan_hashtags
    persisted per-child docs — the same slide produced two detection docs
    (instagram_{parent}_{child}_{hash} next to instagram_{parent}_{hash}).
    The frontend collapsed them on screen; Firestore, detectionsHit and the
    Gemini bill did not."""

    def setUp(self):
        self.writes: dict[str, dict] = {}
        tests_self = self

        class FakeDoc:
            def __init__(self, doc_id):
                self._id = doc_id

            def set(self, payload, merge=False):
                tests_self.writes[self._id] = payload

            def collection(self, name):
                return FakeCol(prefix=f"{self._id}/{name}")

        class FakeCol:
            def __init__(self, prefix=""):
                self._prefix = prefix

            def document(self, doc_id):
                return FakeDoc(f"{self._prefix}/{doc_id}" if self._prefix else doc_id)

        self.posts_col = FakeCol()
        self.new_items: list = []
        from lib import fs as fs_real
        self.fs_real = fs_real
        # _persist_post reads fs.composite_id; give it the real pure function.
        p = mock.patch.object(scan_creators, "fs",
                              types.SimpleNamespace(composite_id=fs_real.composite_id))
        p.start()
        self.addCleanup(p.stop)

    def _sidecar_item(self):
        return {
            "id": "P1", "shortCode": "SC1", "type": "Sidecar",
            "url": "https://instagram.com/p/SC1", "caption": "festival!",
            "hashtags": ["stelz"], "mentions": [],
            "timestamp": "2026-08-22T10:00:00Z",
            "likesCount": 12, "commentsCount": 2,
            "displayUrl": "http://img/1",
            "childPosts": [
                {"id": "C1", "displayUrl": "http://img/1"},
                {"id": "C2", "displayUrl": "http://img/2"},
                # A keyless child: the helper cannot id it, so it must fall
                # back to the parent-keyed fan-out — coverage never drops.
                {"displayUrl": "http://img/3"},
            ],
        }

    def test_children_fan_out_under_child_ids(self):
        creator_by_handle = {"anna": (mock.Mock(), {})}
        scan_creators._persist_post(
            "stelz", {**self._sidecar_item(), "ownerUsername": "anna"},
            "instagram", creator_by_handle, self.posts_col, self.new_items)
        parent_id = self.fs_real.composite_id("instagram", "P1")
        by_url = {url: pid for pid, _kind, url in self.new_items}
        self.assertEqual(by_url["http://img/1"],
                         self.fs_real.composite_id("instagram", "P1_C1"))
        self.assertEqual(by_url["http://img/2"],
                         self.fs_real.composite_id("instagram", "P1_C2"))
        # The keyless child rides on the parent — found, not dropped.
        self.assertEqual(by_url["http://img/3"], parent_id)
        # And NO parent-keyed duplicate exists for the identified children.
        parent_urls = [u for pid, _k, u in self.new_items if pid == parent_id]
        self.assertEqual(parent_urls, ["http://img/3"])

    def test_single_image_post_is_unchanged(self):
        creator_by_handle = {"anna": (mock.Mock(), {})}
        item = {"id": "S1", "type": "Image", "displayUrl": "http://img/solo",
                "ownerUsername": "anna", "timestamp": "2026-08-22T10:00:00Z",
                "caption": "", "hashtags": [], "mentions": []}
        scan_creators._persist_post(
            "stelz", item, "instagram", creator_by_handle, self.posts_col, self.new_items)
        self.assertEqual(self.new_items, [
            (self.fs_real.composite_id("instagram", "S1"), "image", "http://img/solo")])


class TestDetectDenominator(ScanCreatorsBase):
    def test_fanout_bumps_the_scan_denominator(self):
        # Only the hashtag path used to feed detectTasksEnqueued, while the
        # detect workers count completions from EVERY path — completions
        # overshot the denominator and the panel's bar clamped to done.
        brand_sets: list[dict] = []
        fake_brand = types.SimpleNamespace(
            get=lambda: mock.Mock(exists=True),
            set=lambda payload, merge=False: brand_sets.append(payload))
        scan_creators.fs.brand_doc = lambda bid: fake_brand
        self.creators["instagram_anna"] = {
            "status": "discovered", "platform": "instagram", "handle": "anna",
            "nextScanAt": PAST,
        }
        self.apify.scrape_profile_ig.return_value = [{"id": "1"}]
        with mock.patch.object(
            scan_creators, "_persist_post",
            lambda bid, item, plat, cbh, pc, ni: ni.extend(
                [("instagram_1", "image", "http://a"),
                 ("instagram_2", "video", "http://b")]),
        ), mock.patch.object(scan_creators, "pubsub_v1", types.SimpleNamespace(
            PublisherClient=lambda: _CountingPublisher()),
        ), mock.patch.object(scan_creators, "Increment", lambda n: ("INC", n)):
            scan_creators.run("stelz", dry_run=False)
        bumps = [p["scan"]["detectTasksEnqueued"]
                 for p in brand_sets if "scan" in p]
        self.assertEqual(bumps, [("INC", 2)])


class _CountingPublisher:
    def topic_path(self, project, topic):
        return f"{project}/{topic}"

    def publish(self, topic, payload):
        from concurrent.futures import Future
        f = Future()
        f.set_result("id")
        return f


class TestNamedRoster(ScanCreatorsBase):
    """The event pages name their roster instead of taking the due queue.

    The bug this exists for: a project roster sits on a 12-hour cadence, so a
    second press inside that window found nobody due and returned a perfectly
    successful scan of zero accounts. From the button that is indistinguishable
    from "nothing new was posted", which is how a scrape button comes to look
    broken while reporting success.
    """

    def test_a_named_creator_is_scanned_even_when_not_due(self):
        future = dt.datetime(2099, 1, 1, tzinfo=dt.timezone.utc)
        self.creators["instagram_anna"] = {
            "status": "discovered", "platform": "instagram", "handle": "anna",
            "nextScanAt": future,
        }
        # The due queue would find nobody...
        out = self.run_scan()
        self.assertEqual(out["creators_scanned"], 0)
        self.apify.scrape_profile_ig.assert_not_called()

        # ...but naming her scans her anyway.
        self.apify.scrape_profile_ig.return_value = [{"id": "1"}, {"id": "2"}]
        out = self.run_scan(creator_ids=["instagram_anna"])
        self.apify.scrape_profile_ig.assert_called_once()
        self.assertEqual(self.apify.scrape_profile_ig.call_args[0][0], ["anna"])
        self.assertEqual(out["creators_scanned"], 1)

    def test_a_named_creator_with_no_nextScanAt_is_still_scanned(self):
        # The inequality filter excludes docs missing the field entirely, which
        # is what makes a stub invisible to the due queue forever. Naming it has
        # to route around that too, or importing a roster and pressing scan
        # would do nothing until some other pass stamped it.
        self.creators["instagram_bo"] = {
            "status": "discovered", "platform": "instagram", "handle": "bo",
        }
        self.assertEqual(self.run_scan()["creators_scanned"], 0)
        self.assertEqual(self.run_scan(creator_ids=["instagram_bo"])["creators_scanned"], 1)

    def test_both_platforms_come_along(self):
        self.creators["instagram_anna"] = {
            "status": "discovered", "platform": "instagram", "handle": "anna"}
        self.creators["tiktok_anna"] = {
            "status": "discovered", "platform": "tiktok", "handle": "annatt"}
        out = self.run_scan(creator_ids=["instagram_anna", "tiktok_anna"])
        self.assertEqual(out["creators_scanned"], 2)

    def test_ids_that_name_nobody_report_no_creators_not_success(self):
        # "These people are not tracked" and "these people posted nothing" need
        # different answers: the first is fixed by importing the roster, the
        # second by waiting. A bare zero would not tell them apart.
        out = self.run_scan(creator_ids=["instagram_ghost"])
        self.assertEqual(out.get("skipped"), "no_creators")
        self.apify.scrape_profile_ig.assert_not_called()

    def test_an_empty_list_does_not_fall_back_to_the_whole_brand(self):
        # [] must not be read as None. A caller that meant to name a roster and
        # computed an empty one would otherwise scrape the entire brand.
        self.creators["instagram_anna"] = {
            "status": "discovered", "platform": "instagram", "handle": "anna",
            "nextScanAt": PAST,
        }
        out = self.run_scan(creator_ids=[])
        self.assertEqual(out.get("skipped"), "no_creators")
        self.apify.scrape_profile_ig.assert_not_called()

    def test_max_creators_still_caps_a_named_set(self):
        for i in range(5):
            self.creators[f"instagram_c{i}"] = {
                "status": "discovered", "platform": "instagram", "handle": f"c{i}"}
        out = self.run_scan(creator_ids=[f"instagram_c{i}" for i in range(5)],
                            max_creators=2)
        self.assertEqual(out["creators_scanned"], 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)
