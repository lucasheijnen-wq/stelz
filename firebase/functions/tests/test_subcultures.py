"""Subculture matching — lib/subcultures.py.

The classifier decides which scenes a creator is filed under, and those links
feed both the dashboard breakdown and 15% of the SRS. The failure mode that
matters is not a missed link, it is an over-eager one: if generic tags count as
signatures, every creator lands in every scene, the breakdown flattens to noise,
and the SRS layer stops discriminating between anyone.

The legacy seed list had exactly that problem — "weekend", "party", "drinks",
"lifestyle" and "summer" were listed as signature hashtags. They are removed
here, and these tests are what stop them coming back.
"""
from __future__ import annotations

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from lib import subcultures as sc  # noqa: E402


class TestGenericTagsAreNotSignatures(unittest.TestCase):
    GENERIC = ["weekend", "party", "drinks", "lifestyle", "summer", "english", "deal", "plus"]

    def test_no_scene_claims_a_generic_tag(self):
        for spec in sc.STELZ_SUBCULTURES:
            sig = {sc.normalize_tag(t) for t in spec["signature_hashtags"]}
            for g in self.GENERIC:
                self.assertNotIn(
                    g, sig,
                    f"'{g}' is a signature tag of {spec['slug']}. It appears on a large share "
                    f"of all Dutch social posts, so it files nearly everyone into this scene.",
                )

    def test_a_creator_posting_only_generic_tags_is_unplaced(self):
        self.assertEqual(sc.match_creator(self.GENERIC), [])


class TestMatching(unittest.TestCase):
    def test_matches_its_own_scene(self):
        out = sc.match_creator(["vrijmibo", "vrijdagborrel", "afterwork"])
        self.assertEqual(out[0]["slug"], "vrijmibo")
        self.assertEqual(out[0]["confidence"], 1.0)

    def test_hash_prefix_and_case_are_normalised(self):
        a = sc.match_creator(["#Vrijmibo", "  AFTERWORK "])
        b = sc.match_creator(["vrijmibo", "afterwork"])
        self.assertEqual([x["slug"] for x in a], [x["slug"] for x in b])

    def test_one_weak_tag_is_dropped_not_stored(self):
        """A single shared tag is below MIN_CONFIDENCE. Storing it would put a
        creator in a scene on the strength of one word."""
        self.assertEqual(sc.match_creator(["yoga"]), [])

    def test_category_alone_is_enough_for_a_link(self):
        """Category comes from the discovery pipeline rather than from the
        creator's own typing, so it is worth more than any single hashtag."""
        out = sc.match_creator([], category="horeca")
        self.assertEqual([o["slug"] for o in out], ["horeca_nightlife"])
        self.assertTrue(out[0]["byCategory"])

    def test_category_for_a_different_scene_does_not_match(self):
        self.assertEqual(sc.match_creator([], category="media"), [
            {"slug": "media_press", "score": 3, "confidence": 0.5, "matched": [], "byCategory": True},
        ])

    def test_a_creator_can_belong_to_several_scenes(self):
        out = sc.match_creator(["huisfeest", "studentenleven", "borrel", "feestje"])
        slugs = [o["slug"] for o in out]
        self.assertIn("student_life", slugs)
        self.assertIn("house_parties", slugs)

    def test_results_are_ordered_by_confidence(self):
        out = sc.match_creator(["festival", "koningsdag", "lowlands", "yoga", "gym"])
        self.assertEqual(out[0]["slug"], "festivals_events")
        confs = [o["confidence"] for o in out]
        self.assertEqual(confs, sorted(confs, reverse=True))

    def test_matched_tags_are_reported_so_a_link_can_be_explained(self):
        out = sc.match_creator(["festival", "koningsdag"])
        self.assertEqual(out[0]["matched"], ["festival", "koningsdag"])

    def test_empty_input_is_empty_output(self):
        self.assertEqual(sc.match_creator([]), [])
        self.assertEqual(sc.match_creator(None), [])


class TestConfidence(unittest.TestCase):
    def test_saturates_at_one(self):
        self.assertEqual(sc.confidence_for(99), 1.0)

    def test_zero_and_negative_are_zero(self):
        self.assertEqual(sc.confidence_for(0), 0.0)
        self.assertEqual(sc.confidence_for(-3), 0.0)

    def test_two_hashtags_clear_the_storage_threshold(self):
        self.assertGreaterEqual(sc.confidence_for(2 * sc.HASHTAG_WEIGHT), sc.MIN_CONFIDENCE)


class TestSeedIntegrity(unittest.TestCase):
    def test_slugs_are_unique(self):
        slugs = [s["slug"] for s in sc.STELZ_SUBCULTURES]
        self.assertEqual(len(slugs), len(set(slugs)))

    def test_every_scene_has_what_the_ui_renders(self):
        for spec in sc.STELZ_SUBCULTURES:
            for field in ("slug", "name", "description", "color", "emoji"):
                self.assertTrue(spec.get(field), f"{spec.get('slug')} is missing {field}")

    def test_every_scene_can_actually_be_matched(self):
        """A scene with no signature tags and no category can never be entered,
        so it would sit at zero forever and quietly mislead the breakdown."""
        for spec in sc.STELZ_SUBCULTURES:
            self.assertTrue(
                spec.get("signature_hashtags") or spec.get("category_match"),
                f"{spec['slug']} has no way to match anyone",
            )


class TestWidenedCircles(unittest.TestCase):
    """The 2026-08 widening: measured circle names from the repo's own dormant
    seed lists (04_discover_lifestyle, the 13-creator seed), grafted onto the
    EXISTING ten scenes rather than added as new ones — taxonomy stays stable,
    the nets get wider. These pin that the graft actually lands somewhere."""

    def _slugs(self, tags):
        return [m["slug"] for m in sc.match_creator(tags)]

    def test_vriendengroep_circle_lands_in_house_parties(self):
        self.assertIn("house_parties", self._slugs(["ladiesnight", "meidenavond"]))

    def test_werkborrel_circle_lands_in_vrijmibo(self):
        self.assertIn("vrijmibo", self._slugs(["werkborrel", "afterwork"]))

    def test_uitgaansleven_lands_in_nightlife(self):
        self.assertIn("horeca_nightlife", self._slugs(["uitgaansleven", "nachtleven"]))

    def test_introweek_lands_in_student_life(self):
        self.assertIn("student_life", self._slugs(["introweek", "studentenstad"]))

    def test_one_new_tag_alone_still_does_not_place_anyone(self):
        # MIN_CONFIDENCE requires a second signal; widening the nets must not
        # have weakened the guard the whole taxonomy rests on.
        self.assertEqual(sc.match_creator(["ladiesnight"]), [])


if __name__ == "__main__":
    unittest.main()
