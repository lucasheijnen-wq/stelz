"""_run_step and api_scan_session — the two bits of main.py the event button
leans on.

Two defects are pinned here.

1. A HANDLER THAT REFUSED WAS PAINTED GREEN. Every skipped return carries its
   reason (budget_exhausted, budget, no_creators), and _run_step handed all of
   them to step_finished. A brand whose daily budget was exhausted therefore
   looked fully scanned every day while nothing was scraped at all — and the
   reason, which the handler had gone to the trouble of naming, reached nobody.

2. NOTHING OPENED A SCAN SESSION. The flat scan.startedAt/finishedAt pair was
   written by exactly one code path, scan_hashtags.publish_tags. The event
   button does not call hashtags, so its scans ran with no session: no progress
   panel (scanPhase is 'idle' without startedAt), no reload when the scan
   finished, and no lock against a second paid press. api_scan_session is what
   the button opens and closes around its chunk loop.

Unlike the handler tests, this file imports main.py for real — it is importable
in the venv, and the wiring between _run_step and scan_state is precisely what
would otherwise go untested.
"""
from __future__ import annotations

import json
import os
import sys
import types
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import main  # noqa: E402


class FakeReq:
    """Just enough of a flask Request for the paths under test."""

    def __init__(self, body: dict | None = None, method: str = "POST"):
        self.method = method
        self._body = body if body is not None else {"brandId": "stelz"}

    def get_json(self, silent: bool = False):
        return self._body


class Base(unittest.TestCase):
    def setUp(self):
        self.calls: list[tuple] = []
        fake_state = types.SimpleNamespace(
            step_started=lambda bid, step: self.calls.append(("started", step)),
            step_finished=lambda bid, step, counts=None: self.calls.append(("finished", step)),
            step_failed=lambda bid, step, err: self.calls.append(("failed", step, err)),
            step_skipped=lambda bid, step, reason, counts=None: self.calls.append(
                ("skipped", step, reason)),
            session_open=lambda bid: self.calls.append(("open", bid)),
            session_close=lambda bid, end_reason=None: self.calls.append(("close", bid, end_reason)),
        )
        for p in (
            mock.patch.object(main, "scan_state", fake_state),
            mock.patch.object(main, "_require_auth", lambda req: "uid-1"),
            mock.patch.object(main, "_require_brand_member", lambda uid, bid: None),
        ):
            p.start()
            self.addCleanup(p.stop)

    @staticmethod
    def body_of(res) -> dict:
        return json.loads(res.get_data(as_text=True))


class TestSkippedIsNotDone(Base):
    def test_a_refused_step_is_marked_skipped_with_its_reason(self):
        res = main._run_step(
            FakeReq(), lambda bid, body: {"posts_added": 0, "skipped": "budget_exhausted"},
            step="creators")
        self.assertEqual(res.status_code, 200)
        self.assertIn(("skipped", "creators", "budget_exhausted"), self.calls)
        self.assertNotIn(("finished", "creators"), self.calls)

    def test_a_real_run_is_still_marked_done(self):
        main._run_step(FakeReq(), lambda bid, body: {"posts_added": 12}, step="creators")
        self.assertIn(("finished", "creators"), self.calls)
        self.assertNotIn(("skipped", "creators", None), [c for c in self.calls if c[0] == "skipped"])

    def test_the_reason_still_reaches_the_browser_verbatim(self):
        # EventScanButton reads `skipped` and `scope` straight off this body to
        # tell "the budget stopped it" from "the backend is out of date".
        res = main._run_step(
            FakeReq(), lambda bid, body: {"skipped": "no_creators", "scope": "named"},
            step="creators")
        self.assertEqual(self.body_of(res), {"skipped": "no_creators", "scope": "named"})

    def test_an_empty_skipped_value_is_not_treated_as_a_refusal(self):
        # "" and None are absent, not a reason. Only a named cause counts.
        main._run_step(FakeReq(), lambda bid, body: {"skipped": None}, step="creators")
        self.assertIn(("finished", "creators"), self.calls)


class TestScanSessionEndpoint(Base):
    def test_open_starts_a_session(self):
        res = main.api_scan_session.__wrapped__(
            FakeReq({"brandId": "stelz", "action": "open"}))
        self.assertEqual(res.status_code, 200)
        self.assertIn(("open", "stelz"), self.calls)

    def test_close_ends_it(self):
        res = main.api_scan_session.__wrapped__(
            FakeReq({"brandId": "stelz", "action": "close", "endReason": "klaar"}))
        self.assertEqual(res.status_code, 200)
        self.assertIn(("close", "stelz", "klaar"), self.calls)

    def test_an_unknown_action_is_rejected_rather_than_ignored(self):
        res = main.api_scan_session.__wrapped__(
            FakeReq({"brandId": "stelz", "action": "reset"}))
        self.assertEqual(res.status_code, 400)
        self.assertEqual(self.calls, [])

    def test_brand_id_is_required(self):
        res = main.api_scan_session.__wrapped__(FakeReq({"action": "open"}))
        self.assertEqual(res.status_code, 400)
        self.assertEqual(self.calls, [])

    def test_get_is_method_not_allowed(self):
        # The 405 matters: it is what the frontend's probe reads as "this
        # function exists" when a POST fails, so it must keep answering.
        res = main.api_scan_session.__wrapped__(FakeReq(method="GET"))
        self.assertEqual(res.status_code, 405)


if __name__ == "__main__":
    unittest.main(verbosity=2)
