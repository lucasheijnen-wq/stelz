"""The self-reported-age rule exists twice. This is what makes that safe.

The dashboard's Publiek tab ends on a claim: of the accounts shown, this many
state an age. That claim is what justifies showing NO age breakdown at all, so
the count behind it carries weight — it is the evidence for an absence.

The count is produced in Python (tools/stelz_brand_watch/76_audience.py) and the
rule it applies is defined in TypeScript (web/src/lib/communities.selfReportedAge),
which is also what the communities view uses. Two copies of one rule.

If they drift, the dashboard cites a number measured under a rule it does not
use, and it does so while arguing that the data is not there. That is a worse
failure than an ordinary wrong number: it is a wrong number offered as proof.

Only ages a person WROTE DOWN count, in either copy. Neither infers age from
writing style, music taste or a school reference — see the comment above
AGE_IN_BIO in communities.ts for why that line is drawn there.

If this test fails, ONE of the two files is wrong. Decide which by reading the
rule, not by making the patterns match.
"""
from __future__ import annotations

import importlib.util
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
TS = ROOT / "projects/stelz-brand-watch/web/src/lib/communities.ts"
PY = ROOT / "tools/stelz_brand_watch/76_audience.py"


def _load_audience():
    """Import 76_audience by path — it is a numbered script, not a module."""
    spec = importlib.util.spec_from_file_location("_audience76", PY)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class AgeRuleParity(unittest.TestCase):
    def setUp(self):
        if not TS.exists() or not PY.exists():
            self.skipTest("checkout without the dashboard or the tools tree")
        self.audience = _load_audience()

    def test_same_number_of_patterns(self):
        """A pattern added on one side and not the other is the whole failure
        mode: the TS view would report an age the Python count says is absent."""
        ts = re.search(r"const AGE_IN_BIO = \[(.*?)\n\]", TS.read_text(), re.S)
        self.assertIsNotNone(ts, "AGE_IN_BIO not found in communities.ts")
        ts_patterns = [ln for ln in ts.group(1).splitlines() if ln.strip().startswith("/")]
        self.assertEqual(len(ts_patterns), len(self.audience.AGE_IN_BIO))

    def test_agrees_on_stated_ages(self):
        for bio, want in [
            ("23 jaar, Amsterdam", 23),
            ("19yo · lowlands crew", 19),
            ("age: 31", 31),
            ("leeftijd 27", 27),
            ("I am 45 years old", 45),
        ]:
            with self.subTest(bio=bio):
                self.assertEqual(self.audience.self_reported_age(bio), want)

    def test_agrees_on_what_is_not_an_age(self):
        """Every one of these appears in real bios. Reading any of them as an
        age is how a made-up demographic gets onto a client's screen."""
        for bio in [
            None, "", "geen leeftijd hier",
            "2003 baby",             # birth year, not an age
            "50 jaar getrouwd",      # outside 16-49, and not the poster's age
            "15 jaar",               # under 16 — not reported on, by design
            "€23 per ticket",        # a price
            "23k volgers",           # a follower count
            "sinds 1998",            # a year
        ]:
            with self.subTest(bio=bio):
                self.assertIsNone(self.audience.self_reported_age(bio))

    def test_bounds_match_the_typescript_guard(self):
        """communities.ts re-checks 16..49 after matching. So does Python, and
        the boundaries have to land the same way on both sides."""
        self.assertEqual(self.audience.self_reported_age("16 jaar"), 16)
        self.assertEqual(self.audience.self_reported_age("49 jaar"), 49)
        self.assertIsNone(self.audience.self_reported_age("50 jaar"))
        self.assertIsNone(self.audience.self_reported_age("15 jaar"))


if __name__ == "__main__":
    unittest.main()
