"""Scan progress — the counters the UI draws its bar from.

Four defects are pinned here, all of them ones that made a working scan look
broken:

1. The bump lived inside _persist, so every early return skipped it. The
   commonest one, fetch_failed, is the EXPECTED outcome for an Instagram CDN
   URL that expired while queued — which meant the "analysing" bar could never
   reach 100% on any real scan.
2. detect_video never bumped, while the detect_image calls it makes per frame
   each bumped once: one video message moved the bar N places while the queue
   counted it as one.
3. lastActivityAt was frozen through the whole detect phase, so the client's
   5-minute stall detector reported healthy scans as dead.
4. A failing step wrote nothing anywhere, so five of the seven steps could fail
   in silence.
"""
from __future__ import annotations

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


def _stub_if_missing(name: str) -> None:
    """Stub only what this environment cannot import.

    Module stubs live in sys.modules for the whole process, so stubbing a
    package that really exists (PIL) silently breaks every later test module
    that relies on the real one.
    """
    try:
        __import__(name)
    except Exception:
        _stub(name)


for _n in (
    "firebase_admin", "firebase_admin.firestore", "firebase_admin.storage",
    "google.cloud", "google.cloud.firestore", "google.cloud.pubsub_v1",
    "google.genai", "google.genai.types", "cv2", "yt_dlp",
):
    _stub_if_missing(_n)
if not hasattr(_stub("firebase_admin"), "initialize_app"):
    _stub("firebase_admin").initialize_app = lambda *a, **k: None
    _stub("firebase_admin").get_app = lambda *a, **k: None
    _stub("firebase_admin").credentials = types.SimpleNamespace(ApplicationDefault=lambda: None)
if "google.genai" in sys.modules and not hasattr(sys.modules["google.genai"], "Client"):
    sys.modules["google.genai"].Client = lambda *a, **k: None
if "yt_dlp" in sys.modules and not hasattr(sys.modules["yt_dlp"], "YoutubeDL"):
    sys.modules["yt_dlp"].YoutubeDL = lambda *a, **k: None


class FakeIncrement:
    """Real increment semantics, so a double bump is visible in the total."""

    def __init__(self, n):
        self.n = n


_fsmod = _stub("google.cloud.firestore")
if not hasattr(_fsmod, "SERVER_TIMESTAMP"):
    _fsmod.SERVER_TIMESTAMP = "TS"
_fsmod.Increment = FakeIncrement
for _attr in ("ArrayUnion", "ArrayRemove"):
    if not hasattr(_fsmod, _attr):
        setattr(_fsmod, _attr, lambda v: v)

from lib import scan_state  # noqa: E402

scan_state.Increment = FakeIncrement


class FakeBrandDoc:
    """Applies merges, Increments and dotted-path updates like Firestore."""

    def __init__(self, data: dict):
        self.data = data

    def set(self, patch: dict, merge=False):
        if not merge:
            self.data.clear()
        _deep_merge(self.data, patch)

    def update(self, patch: dict):
        for path, value in patch.items():
            cur = self.data
            parts = path.split(".")
            for p in parts[:-1]:
                cur = cur.setdefault(p, {})
            cur[parts[-1]] = value

    def get(self):
        return types.SimpleNamespace(exists=True, to_dict=lambda: dict(self.data))


def _deep_merge(dst: dict, patch: dict) -> None:
    for k, v in patch.items():
        if isinstance(v, FakeIncrement):
            dst[k] = (dst.get(k) or 0) + v.n
        elif isinstance(v, dict):
            _deep_merge(dst.setdefault(k, {}), v)
        else:
            dst[k] = v


class ScanStateBase(unittest.TestCase):
    def setUp(self):
        self.brand: dict = {}
        doc = FakeBrandDoc(self.brand)
        p = mock.patch.object(scan_state, "fs", types.SimpleNamespace(brand_doc=lambda bid: doc))
        p.start()
        self.addCleanup(p.stop)


class TestStepsMap(ScanStateBase):
    def test_started_finished_shape(self):
        scan_state.step_started("stelz", "creators")
        self.assertEqual(self.brand["scan"]["steps"]["creators"]["state"], "running")
        scan_state.step_finished("stelz", "creators", {"creators_scanned": 12})
        step = self.brand["scan"]["steps"]["creators"]
        self.assertEqual(step["state"], "done")
        self.assertEqual(step["counts"]["creators_scanned"], 12)

    def test_failure_is_recorded_instead_of_vanishing(self):
        scan_state.step_started("stelz", "srs")
        scan_state.step_failed("stelz", "srs", "boom" * 200)
        step = self.brand["scan"]["steps"]["srs"]
        self.assertEqual(step["state"], "error")
        self.assertLessEqual(len(step["error"]), 300)

    def test_restart_clears_the_previous_runs_error(self):
        # Dotted-path update replaces the whole map; a merge would leave last
        # week's failure sitting underneath a green step.
        scan_state.step_started("stelz", "srs")
        scan_state.step_failed("stelz", "srs", "boom")
        scan_state.step_started("stelz", "srs")
        self.assertIsNone(self.brand["scan"]["steps"]["srs"]["error"])
        self.assertEqual(self.brand["scan"]["steps"]["srs"]["counts"], {})

    def test_counts_are_reduced_to_primitives(self):
        scan_state.step_finished("stelz", "creators", {"ok": 1, "junk": object(), "tags": ["a"]})
        counts = self.brand["scan"]["steps"]["creators"]["counts"]
        self.assertEqual(counts, {"ok": 1})

    def test_progress_reporting_never_raises(self):
        # A broken brand doc must not be able to fail a scan.
        with mock.patch.object(scan_state, "fs", types.SimpleNamespace(
                brand_doc=lambda bid: (_ for _ in ()).throw(RuntimeError("nope")))):
            scan_state.step_started("stelz", "creators")
            scan_state.step_finished("stelz", "creators", {})
            scan_state.step_failed("stelz", "creators", "x")
            scan_state.bump_detect_progress("stelz", hit=True)


class TestDetectBump(ScanStateBase):
    def test_bump_moves_all_counters_and_the_heartbeat(self):
        scan_state.bump_detect_progress("stelz", hit=True)
        scan_state.bump_detect_progress("stelz", hit=False, skipped=True)
        scan = self.brand["scan"]
        self.assertEqual(scan["detectionsCompleted"], 2)
        self.assertEqual(scan["detectionsHit"], 1)
        self.assertEqual(scan["skippedCount"], 1)
        # Without this the 5-minute stall detector fires during a healthy
        # detect phase, because nothing else writes lastActivityAt.
        self.assertEqual(scan["lastActivityAt"], scan_state.SERVER_TIMESTAMP)


class TestDetectImageWrapper(unittest.TestCase):
    """The bump must fire once on EVERY terminal path of detect_image.run."""

    def setUp(self):
        from handlers import detect_image
        self.detect_image = detect_image
        self.bumps: list[dict] = []
        p = mock.patch.object(
            detect_image, "scan_state",
            types.SimpleNamespace(bump_detect_progress=lambda bid, hit, skipped=False:
                                  self.bumps.append({"hit": hit, "skipped": skipped})),
        )
        p.start()
        self.addCleanup(p.stop)

    def _run_with(self, inner):
        with mock.patch.object(self.detect_image, "_run_inner", inner):
            return self.detect_image.run("stelz", "post1", "https://x/y.jpg")

    def test_fetch_failed_still_counts(self):
        # THE bug: an expired Instagram CDN URL is expected, and used to leave
        # the numerator permanently short of the denominator.
        self._run_with(lambda *a, **k: {"status": "error", "reason": "fetch_failed"})
        self.assertEqual(self.bumps, [{"hit": False, "skipped": False}])

    def test_budget_skip_counts_as_skipped(self):
        self._run_with(lambda *a, **k: {"status": "skip", "reason": "budget_exhausted"})
        self.assertEqual(self.bumps, [{"hit": False, "skipped": True}])

    def test_a_hit_counts_once_not_twice(self):
        self._run_with(lambda *a, **k: {"status": "ok", "detected": True})
        self.assertEqual(self.bumps, [{"hit": True, "skipped": False}])

    def test_a_crash_still_counts(self):
        def boom(*a, **k):
            raise RuntimeError("gemini exploded")
        with self.assertRaises(RuntimeError):
            self._run_with(boom)
        self.assertEqual(self.bumps, [{"hit": False, "skipped": False}])

    def test_nested_calls_do_not_count(self):
        with mock.patch.object(self.detect_image, "_run_inner", lambda *a, **k: {"status": "ok", "detected": True}):
            self.detect_image.run("stelz", "post1", "https://x/y.jpg", bump_progress=False)
        self.assertEqual(self.bumps, [])


class TestDetectVideoWrapper(unittest.TestCase):
    """One video message = one unit, however many frames it analyses."""

    def setUp(self):
        from handlers import detect_video
        self.detect_video = detect_video
        self.bumps: list[dict] = []
        p = mock.patch.object(
            detect_video, "scan_state",
            types.SimpleNamespace(bump_detect_progress=lambda bid, hit, skipped=False:
                                  self.bumps.append({"hit": hit, "skipped": skipped})),
        )
        p.start()
        self.addCleanup(p.stop)

    def test_six_frames_still_count_as_one_message(self):
        with mock.patch.object(self.detect_video, "_run_inner",
                               lambda *a, **k: {"status": "ok", "hit": True, "framesAnalysed": 6}):
            self.detect_video.run("stelz", "post1", "https://x/v.mp4")
        self.assertEqual(self.bumps, [{"hit": True, "skipped": False}])

    def test_download_failure_counts_as_skipped(self):
        with mock.patch.object(self.detect_video, "_run_inner",
                               lambda *a, **k: {"status": "skip", "reason": "download_failed"}):
            self.detect_video.run("stelz", "post1", "https://x/v.mp4")
        self.assertEqual(self.bumps, [{"hit": False, "skipped": True}])


class TestScanSession(ScanStateBase):
    """The flat startedAt/finishedAt pair — what the whole UI calls "a scan".

    Until session_open existed, exactly one code path wrote these fields
    (scan_hashtags.publish_tags). The event button does not call hashtags, so
    an event scan ran with no session at all: the progress panel never mounted
    (scanPhase returns 'idle' without startedAt), the page never reloaded when
    the scan finished, and the button never locked against a second paid press.
    """

    def test_open_marks_a_scan_running(self):
        scan_state.session_open("stelz")
        self.assertEqual(self.brand["scan"]["startedAt"], scan_state.SERVER_TIMESTAMP)
        self.assertIsNone(self.brand["scan"]["finishedAt"])
        self.assertTrue(scan_state.session_is_open("stelz"))

    def test_close_ends_it(self):
        scan_state.session_open("stelz")
        scan_state.session_close("stelz")
        self.assertEqual(self.brand["scan"]["finishedAt"], scan_state.SERVER_TIMESTAMP)
        self.assertFalse(scan_state.session_is_open("stelz"))

    def test_opening_resets_the_previous_run_counters(self):
        """A session that inherited last week's totals reported this week's
        completions against a stale denominator, so the panel snapped a
        finished scan back to 'analysing' with an ETA off the old startedAt."""
        self.brand["scan"] = {
            "startedAt": "last week", "finishedAt": "also last week",
            "detectTasksEnqueued": 1200, "detectionsCompleted": 1200,
            "detectionsHit": 42, "skippedCount": 7,
        }
        scan_state.session_open("stelz")
        self.assertEqual(self.brand["scan"]["detectTasksEnqueued"], 0)
        self.assertEqual(self.brand["scan"]["detectionsCompleted"], 0)
        self.assertEqual(self.brand["scan"]["detectionsHit"], 0)
        self.assertEqual(self.brand["scan"]["skippedCount"], 0)

    def test_no_session_at_all_is_not_open(self):
        self.assertFalse(scan_state.session_is_open("stelz"))

    def test_a_session_never_closed_still_counts_as_open(self):
        # The stall detector, not this function, is what calls time on those.
        self.brand["scan"] = {"startedAt": "ages ago", "finishedAt": None}
        self.assertTrue(scan_state.session_is_open("stelz"))


class TestStepSkipped(ScanStateBase):
    """A handler that refused is not a step that succeeded.

    Every skipped return carries a reason (budget_exhausted, budget,
    no_creators). Painting those green said a scan had run when the budget gate
    had turned it away — a brand could look scanned all week with not one
    request having left the building.
    """

    def test_skipped_is_its_own_state_and_keeps_the_reason(self):
        scan_state.step_started("stelz", "creators")
        scan_state.step_skipped("stelz", "creators", "budget_exhausted", {"posts_added": 0})
        step = self.brand["scan"]["steps"]["creators"]
        self.assertEqual(step["state"], "skipped")
        self.assertEqual(step["error"], "budget_exhausted")
        self.assertEqual(step["finishedAt"], scan_state.SERVER_TIMESTAMP)

    def test_skipped_is_not_done(self):
        scan_state.step_started("stelz", "creators")
        scan_state.step_skipped("stelz", "creators", "no_creators")
        self.assertNotEqual(self.brand["scan"]["steps"]["creators"]["state"], "done")

    def test_a_failing_write_is_swallowed(self):
        # Same contract as every other function here: progress reporting must
        # never be the reason a scan fails.
        with mock.patch.object(scan_state, "fs", types.SimpleNamespace(
                brand_doc=lambda bid: (_ for _ in ()).throw(RuntimeError("no db")))):
            scan_state.session_open("stelz")
            scan_state.session_close("stelz")
            scan_state.step_skipped("stelz", "creators", "budget")
            self.assertFalse(scan_state.session_is_open("stelz"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
