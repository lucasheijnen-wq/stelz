"""The price table exists twice. This is what makes that safe.

Money is priced in Python (lib/usage.COST_PER_UNIT, measured against a real
invoice) and displayed by the React app, which cannot import Python. The last
time those two drifted, the frontend copy charged $0.10 for an Apify run that
is free while omitting the $2.30/1k results line that is the actual bill —
under-reporting Apify spend by roughly 11x. It went unnoticed for one reason
only: the function had no call sites, so the wrong number was never rendered.

Now that costs go on screen, drift has to fail loudly. This reads the TypeScript
file as text and compares it key by key. Python reads the file directly, so
there is no bundler or module-resolution machinery involved on either side.

If this test fails, ONE of the two files is wrong — decide which by checking
against the billing, not by making the numbers match.
"""
from __future__ import annotations

import os
import re
import sys
import types
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _stub_if_missing(name: str) -> types.ModuleType:
    """Only stub what the system python cannot import. Stubbing unconditionally
    shadows real packages for every test in the process — that shipped once and
    broke the verifier suite."""
    try:
        return __import__(name)
    except Exception:
        pass
    mod = sys.modules.get(name)
    if mod is None:
        mod = types.ModuleType(name)
        sys.modules[name] = mod
    if "." in name:
        parent, _, child = name.rpartition(".")
        setattr(_stub_if_missing(parent), child, mod)
    return mod


for _n in ("firebase_admin", "firebase_admin.firestore", "firebase_admin.storage",
           "google.cloud", "google.cloud.firestore"):
    _stub_if_missing(_n)
_fb = sys.modules["firebase_admin"]
if not hasattr(_fb, "initialize_app"):
    _fb.initialize_app = lambda *a, **k: None
    _fb.get_app = lambda *a, **k: None
    _fb.credentials = types.SimpleNamespace(ApplicationDefault=lambda: None)
_fsmod = sys.modules["google.cloud.firestore"]
for _attr, _val in (("SERVER_TIMESTAMP", "TS"), ("Increment", lambda *a, **k: None),
                    ("ArrayUnion", lambda v: v), ("ArrayRemove", lambda v: v)):
    if not hasattr(_fsmod, _attr):
        setattr(_fsmod, _attr, _val)

COSTS_TS = (
    Path(__file__).resolve().parents[3]
    / "projects" / "stelz-brand-watch" / "web" / "src" / "lib" / "costs.ts"
)


def parse_ts_table(src: str, const_name: str) -> dict[str, float]:
    """Pull `export const <name>: Record<string, number> = { k: v, ... }`."""
    m = re.search(
        rf"export const {const_name}\s*:[^=]*=\s*\{{(.*?)\n\}}",
        src, re.DOTALL,
    )
    if not m:
        raise AssertionError(f"{const_name} not found in costs.ts")
    out: dict[str, float] = {}
    for key, val in re.findall(r"(\w+)\s*:\s*([0-9.]+)\s*,", m.group(1)):
        out[key] = float(val)
    return out


class TestCostParity(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if not COSTS_TS.exists():
            raise unittest.SkipTest(f"costs.ts not found at {COSTS_TS}")
        cls.src = COSTS_TS.read_text()
        cls.ts = parse_ts_table(cls.src, "COST_PER_UNIT")

    def py(self) -> dict[str, float]:
        from lib import usage
        return dict(usage.COST_PER_UNIT)

    def test_same_keys(self):
        py, ts = self.py(), self.ts
        self.assertEqual(
            sorted(ts), sorted(py),
            "costs.ts and lib/usage.py price different things.\n"
            f"  only in costs.ts: {sorted(set(ts) - set(py))}\n"
            f"  only in usage.py: {sorted(set(py) - set(ts))}",
        )

    def test_same_amounts(self):
        py = self.py()
        for key, price in py.items():
            with self.subTest(unit=key):
                self.assertAlmostEqual(
                    self.ts.get(key, -1), price, places=6,
                    msg=f"{key}: costs.ts says {self.ts.get(key)}, usage.py says {price}",
                )

    def test_the_two_amounts_that_were_wrong_before(self):
        # Named explicitly so a future edit that reintroduces the old model
        # fails on the specific claim rather than on a generic mismatch.
        self.assertAlmostEqual(self.ts["gemini_flash_calls"], 0.00175, places=6,
                               msg="the old frontend copy said 0.00075")
        self.assertAlmostEqual(self.ts["apify_ig_results"], 0.0023, places=6,
                               msg="the old frontend copy omitted this entirely")

    def test_free_runs_are_not_priced(self):
        # apify_runs is counted for visibility and costs nothing. Pricing it is
        # exactly what the broken copy did, at $0.10 a run.
        from lib import usage
        self.assertNotIn("apify_runs", usage.COST_PER_UNIT)
        self.assertNotIn("apify_runs", self.ts)
        self.assertIn("apify_runs", self.src,
                      "costs.ts should still SHOW runs as a free volume counter")

    def test_every_priced_unit_has_a_label(self):
        # A number on screen with no name is worse than no number.
        meta = set(re.findall(r"^  (\w+): \{", self.src, re.MULTILINE))
        missing = sorted(set(self.ts) - meta)
        self.assertEqual(missing, [], f"UNIT_META missing entries for {missing}")

    def test_degrade_thresholds_match_the_backend(self):
        # The UI names the rung the backend is standing on; different cut-offs
        # would have it announce full speed while scraping is already throttled.
        for pct in ("0.70", "0.85", "0.95"):
            self.assertIn(pct, self.src, f"degrade threshold {pct} missing from costs.ts")
        from lib import usage
        src = Path(usage.__file__).read_text()
        for pct in ("0.70", "0.85", "0.95"):
            self.assertIn(pct, src, f"degrade threshold {pct} missing from usage.py")


class TestRecipeInputsMatchTheCallSites(unittest.TestCase):
    """The price card claims to describe the button you are about to press."""

    @classmethod
    def setUpClass(cls):
        if not COSTS_TS.exists():
            raise unittest.SkipTest("costs.ts not found")
        cls.costs = COSTS_TS.read_text()
        cls.firestore_ts = (COSTS_TS.parent / "firestore.ts").read_text()

    def test_defaults_match_what_the_ui_actually_sends(self):
        # fbStepHashtags(perTag = 500, maxTags = 50) etc. If someone changes the
        # call site and not the table, the price card quietly starts describing
        # a scan nobody runs.
        # The trailing `[,)]` lets the signature GROW — fbStepCreators gained an
        # optional creatorIds for the event pages — while still pinning the two
        # defaults, which is the thing the price card actually depends on.
        # Anchoring on `\)` made this test fail on a new parameter that could
        # not affect a price, which teaches people to loosen the assertion
        # rather than read it.
        for sig, keys in (
            (r"fbStepHashtags\(perTag = (\d+), maxTags = (\d+)[,)]", ("hashtagPerTag", "hashtagMaxTags")),
            (r"fbStepCreators\(maxCreators = (\d+), postsPer = (\d+)[,)]", ("creatorMax", "creatorPostsPer")),
        ):
            m = re.search(sig, self.firestore_ts)
            self.assertIsNotNone(m, f"call site not found: {sig}")
            for value, key in zip(m.groups(), keys):
                found = re.search(rf"{key}: (\d+)", self.costs)
                self.assertIsNotNone(found, f"{key} missing from DEFAULTS")
                self.assertEqual(found.group(1), value,
                                 f"DEFAULTS.{key} is {found.group(1)}, call site sends {value}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
