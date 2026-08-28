"""Tests for which hashtags actually get scanned.

The bug these pin: publish_tags took `sorted(pool, key=priority)[:max_tags]`,
and with the shipped 117-tag pool at the shipped max_tags=50 that removed all 45
typo tags, all 12 lifestyle tags and all 6 category tags — every time, silently.
Lifestyle tags are the creator-prospecting surface, which lib/hashtags.py calls
"the only route to untagged content", and untagged content is the product.

A regression here is invisible in production: the scan still runs, still returns
posts, and nobody sees that a whole discovery surface stopped being queried. So
the coverage guarantee is asserted directly against the real shipped pool.
"""
from __future__ import annotations

import os
import sys
import unittest
from collections import Counter

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib import hashtags  # noqa: E402


def _pool(spec: dict[str, int]) -> list[dict]:
    """Build a pool from {family: count} using real family priorities."""
    out = []
    for fam, n in spec.items():
        prio, cap, _ = hashtags.FAMILIES[fam]
        for i in range(n):
            out.append({"tag": f"{fam}{i}", "family": fam, "priority": prio, "maxResults": cap})
    return out


class TestSelectTags(unittest.TestCase):
    def test_no_family_is_wiped_out(self):
        # The actual bug, on the actual shipped pool.
        pool = hashtags.stelz_pool("instagram") + hashtags.stelz_pool("tiktok")
        picked = Counter(d["family"] for d in hashtags.select_tags(pool, 50))
        for fam in {d["family"] for d in pool}:
            self.assertGreater(picked[fam], 0, f"{fam} was cut entirely — the original bug")

    def test_lifestyle_survives_the_real_cut(self):
        pool = hashtags.stelz_pool("instagram") + hashtags.stelz_pool("tiktok")
        picked = [d for d in hashtags.select_tags(pool, 50) if d["family"] == "lifestyle"]
        self.assertGreaterEqual(len(picked), 1)

    def test_the_old_behaviour_really_did_drop_them(self):
        # Guards the premise. If this ever fails, the fix is aimed at nothing.
        pool = hashtags.stelz_pool("instagram") + hashtags.stelz_pool("tiktok")
        old = sorted(pool, key=lambda d: d.get("priority", 0), reverse=True)[:50]
        self.assertEqual(sum(1 for d in old if d["family"] == "lifestyle"), 0)

    def test_high_priority_families_still_dominate(self):
        # Fairness must not become equality — brand tags are where the hits are.
        pool = hashtags.stelz_pool("instagram") + hashtags.stelz_pool("tiktok")
        picked = Counter(d["family"] for d in hashtags.select_tags(pool, 50))
        self.assertGreater(picked["brand_core"], picked["lifestyle"])

    def test_respects_max_tags(self):
        pool = _pool({"brand_core": 20, "lifestyle": 20, "brand_typo": 20})
        for n in (1, 5, 12, 50, 60):
            self.assertLessEqual(len(hashtags.select_tags(pool, n)), n)

    def test_returns_everything_when_capacity_exceeds_the_pool(self):
        pool = _pool({"brand_core": 3, "lifestyle": 2})
        self.assertEqual(len(hashtags.select_tags(pool, 99)), 5)

    def test_tiny_budget_spends_on_the_best_families_first(self):
        # With room for 3, the floor cannot cover everything — the squeezed-out
        # families must be the low-priority ones, not arbitrary.
        pool = _pool({"brand_core": 5, "lifestyle": 5})
        picked = hashtags.select_tags(pool, 3)
        self.assertTrue(all(d["family"] == "brand_core" for d in picked))

    def test_is_deterministic(self):
        # Two runs must enqueue the same tags or week-on-week yield comparisons
        # are meaningless.
        pool = hashtags.stelz_pool("instagram")
        first = [d["tag"] for d in hashtags.select_tags(pool, 40)]
        for _ in range(5):
            self.assertEqual([d["tag"] for d in hashtags.select_tags(pool, 40)], first)

    def test_handles_empty_and_zero(self):
        self.assertEqual(hashtags.select_tags([], 50), [])
        self.assertEqual(hashtags.select_tags(_pool({"brand_core": 5}), 0), [])

    def test_survives_a_pool_entry_with_no_family_or_priority(self):
        # Firestore docs are user-editable; a missing field must not crash a scan.
        pool = [{"tag": "orphan"}, *_pool({"brand_core": 2})]
        self.assertEqual(len(hashtags.select_tags(pool, 3)), 3)


class TestProjectedResults(unittest.TestCase):
    def test_uses_the_per_family_cap_when_it_is_lower(self):
        # lifestyle is capped at 60/tag, so 500 must not be charged for it.
        lifestyle = _pool({"lifestyle": 1})
        self.assertEqual(hashtags.projected_results(lifestyle, 500), 60)

    def test_uncapped_family_uses_the_caller_number(self):
        self.assertEqual(hashtags.projected_results(_pool({"brand_core": 1}), 500), 500)

    def test_never_raises_the_caller_number(self):
        self.assertEqual(hashtags.projected_results(_pool({"brand_event": 1}), 100), 100)

    def test_the_fix_is_not_more_expensive(self):
        # The restored families carry caps, so they displace uncapped tags and
        # the selection actually gets cheaper. If this inverts, the change needs
        # a budget conversation before it ships.
        pool = hashtags.stelz_pool("instagram") + hashtags.stelz_pool("tiktok")
        old = sorted(pool, key=lambda d: d.get("priority", 0), reverse=True)[:50]
        new = hashtags.select_tags(pool, 50)
        self.assertLessEqual(
            hashtags.projected_results(new, 500),
            hashtags.projected_results(old, 500),
        )

    def test_empty_selection_costs_nothing(self):
        self.assertEqual(hashtags.projected_results([], 500), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)


class TestPoolPatchDocs(unittest.TestCase):
    """The two-regime rule for hashtag-pool saves.

    The dangerous direction: the Settings UI round-trips the ENTIRE pool on
    every save. If defaults applied to existing tags, one click of Save would
    restamp all ~117 seeded tags as family="custom" — quietly destroying the
    taxonomy that select_tags budgets by, with no error anywhere.
    """

    def test_new_tag_gets_the_cost_cap_by_default(self):
        # The cap IS the feature: an uncapped UI tag scrapes 500 results
        # (~$1.15) per scan.
        [(doc_id, doc)] = hashtags.pool_patch_docs(
            [{"tag": "zomerfestival"}], existing_ids=set())
        self.assertEqual(doc_id, "instagram_zomerfestival")
        self.assertEqual(doc["family"], "custom")
        self.assertEqual(doc["maxResults"], 200)
        self.assertEqual(doc["kind"], "hashtag")

    def test_existing_tag_is_never_restamped(self):
        # Round-tripped seeded tag without explicit family/cap fields: the
        # write must not contain them at all (merge=True leaves them be).
        [(_, doc)] = hashtags.pool_patch_docs(
            [{"tag": "stelz", "priority": 10}],
            existing_ids={"instagram_stelz"})
        self.assertNotIn("family", doc)
        self.assertNotIn("maxResults", doc)
        self.assertNotIn("kind", doc)

    def test_explicit_fields_do_update_an_existing_tag(self):
        [(_, doc)] = hashtags.pool_patch_docs(
            [{"tag": "stelz", "maxResults": 300, "family": "brand_core"}],
            existing_ids={"instagram_stelz"})
        self.assertEqual(doc["maxResults"], 300)
        self.assertEqual(doc["family"], "brand_core")

    def test_cap_is_clamped_to_sane_bounds(self):
        [(_, lo)] = hashtags.pool_patch_docs([{"tag": "a1", "maxResults": 1}], set())
        [(_, hi)] = hashtags.pool_patch_docs([{"tag": "b1", "maxResults": 99999}], set())
        self.assertEqual(lo["maxResults"], 10)
        self.assertEqual(hi["maxResults"], 1000)

    def test_garbage_cap_falls_back_to_default(self):
        [(_, doc)] = hashtags.pool_patch_docs(
            [{"tag": "x1", "maxResults": "veel"}], set())
        self.assertEqual(doc["maxResults"], 200)

    def test_invalid_family_is_dropped_not_written(self):
        [(_, doc)] = hashtags.pool_patch_docs(
            [{"tag": "x1", "family": "spam_family"}], existing_ids={"instagram_x1"})
        self.assertNotIn("family", doc)

    def test_invalid_kind_becomes_hashtag(self):
        [(_, doc)] = hashtags.pool_patch_docs([{"tag": "x1", "kind": "regex"}], set())
        self.assertEqual(doc["kind"], "hashtag")

    def test_keyword_kind_is_accepted_as_data_prep(self):
        [(_, doc)] = hashtags.pool_patch_docs([{"tag": "hard seltzer", "kind": "keyword"}], set())
        self.assertEqual(doc["kind"], "keyword")

    def test_custom_family_survives_select_tags(self):
        # End-to-end with the real selector: a client-added tag must never be
        # starved out of a scan by the priority sort — that was the original
        # lifestyle-tag bug in a new coat.
        pool = hashtags.stelz_pool("instagram")
        writes = hashtags.pool_patch_docs([{"tag": "mijneigenterm"}], set())
        pool = pool + [doc for _, doc in writes]
        picked = hashtags.select_tags(pool, 50)
        self.assertIn("mijneigenterm", [d["tag"] for d in picked])

    def test_blank_tag_is_skipped(self):
        self.assertEqual(hashtags.pool_patch_docs([{"tag": "  "}, {"tag": "#ok"}], set())[0][0],
                         "instagram_ok")


class TestExplicitTagList(unittest.TestCase):
    """publish_tags(tags=[...]) — how an EVENT scrapes its own hashtags.

    A festival's tags live in its event JSON and are never copied into the brand
    pool (a tag left there is scraped forever after the festival ends). Without
    this path a scrape started from an event page scanned the brand pool and
    never touched #lowlands — the button looked like it worked.
    """

    def test_wraps_entries_so_the_pool_path_can_read_them(self):
        from handlers.scan_hashtags import _PlainTag
        d = _PlainTag({"tag": "lowlands", "platform": "instagram"}).to_dict()
        self.assertEqual(d["tag"], "lowlands")
        self.assertEqual(d["platform"], "instagram")
        self.assertTrue(d["active"])

    def test_explicit_tags_are_never_dropped_by_the_stratifier(self):
        # An explicitly requested tag competing against the real pool must
        # survive the cut — someone asked for it by name.
        from handlers.scan_hashtags import _PlainTag
        from lib import hashtags
        pool = [{**t, "_doc": None} for t in hashtags.stelz_pool("instagram")]
        mine = {**_PlainTag({"tag": "lowlands2026"}).to_dict(), "_doc": None}
        selected = hashtags.select_tags(pool + [mine], 5)
        self.assertIn("lowlands2026", [t["tag"] for t in selected])
