"""Dezelfde clip, twee archieven, één keer — op elke laag.

Een video gevonden via #stelz (discovery-archief) én via de profielscrape van
zijn poster (tiktok-archief) is één stuk inhoud dat twee keer in de
administratie staat. Dat kostte drie keer:

  1. de fixture toonde twee identieke kaarten en telde twee treffers (72),
  2. Gemini beoordeelde dezelfde pixels twee keer — ronde A2 verloor er $0,60
     aan (74),
  3. en de identiteit waarmee beide dat voorkomen moet HETZELFDE zijn, anders
     voegt 72 samen wat 74 alsnog dubbel liet betalen.

De id-TEKST is géén identiteit: discovery zet "ig" voor Instagram-ids, dus
identiteit komt uit de archiefvelden (handle+video_id, of
handle+shortcode+dia). Deze tests pinnen de merge, het hergebruik, en de
spiegel tussen beide.
"""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import unittest
from pathlib import Path

ROOT = Path(os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__))))))
TOOLS = ROOT / "tools" / "stelz_brand_watch"


def _load(name: str, fname: str):
    spec = importlib.util.spec_from_file_location(name, TOOLS / fname)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


F = _load("_fixture72", "72_campaign_fixture.py")

TT_PROFIEL = {"video_id": "7676", "handle": "anna", "platform": "tiktok",
              "play_count": 12000, "digg_count": 300, "found_via": None,
              "hashtags": ["fyp"], "posted_at": "2026-08-22T10:00:00Z"}
TT_TAG = {"video_id": "7676", "handle": "anna", "platform": "tiktok",
          "play_count": None, "digg_count": None, "found_via": "stelz",
          "hashtags": ["stelz", "lowlands"], "posted_at": "2026-08-22T10:00:00Z"}
IG_PROFIEL = {"item_id": "DcXs0", "short_code": "DcX", "slot": 0, "slots": 3,
              "handle": "bram", "likes_count": 38, "found_via": None,
              "hashtags": [], "posted_at": "2026-08-21T09:00:00Z"}
IG_TAG = {"video_id": "igDcXs0", "short_code": "DcX", "slot": 0, "slots": 3,
          "handle": "bram", "platform": "instagram", "likes_count": None,
          "found_via": "lowlands2026", "hashtags": ["lowlands2026"],
          "posted_at": "2026-08-21T09:00:00Z"}


class TestContentKey(unittest.TestCase):
    """De identiteit zelf: velden, geen id-tekst."""

    def test_tiktok_twee_archieven_zelfde_sleutel(self):
        self.assertEqual(F.content_key(TT_PROFIEL, "tiktok", "tiktok", "7676"),
                         F.content_key(TT_TAG, "tiktok", "discovery", "7676"))

    def test_instagram_ondanks_ig_prefix_zelfde_sleutel(self):
        self.assertEqual(F.content_key(IG_PROFIEL, "post", "ig-posts", "DcXs0"),
                         F.content_key(IG_TAG, "post", "discovery", "igDcXs0"))

    def test_andere_dia_is_andere_inhoud(self):
        andere = dict(IG_TAG, video_id="igDcXs1", slot=1)
        self.assertNotEqual(F.content_key(IG_TAG, "post", "discovery", "igDcXs0"),
                            F.content_key(andere, "post", "discovery", "igDcXs1"))

    def test_stories_nooit_samengevoegd(self):
        a = F.content_key({"handle": "anna"}, "story", "stories", "111")
        b = F.content_key({"handle": "anna"}, "story", "stories", "222")
        self.assertNotEqual(a, b)


class TestMergeGroup(unittest.TestCase):
    """72's samenvoeging: tag en cijfers overleven allebei."""

    RANK = {"tiktok": 0, "discovery": 1}

    def test_tag_en_cijfers_overleven_de_merge(self):
        grp = [{"kind": "tiktok", "e": TT_PROFIEL, "v": {"detected": True}},
               {"kind": "discovery", "e": TT_TAG, "v": {"detected": True}}]
        out = F.merge_group(grp, self.RANK)
        # De profielkopie wint (KINDS-volgorde bij gelijk verdict), maar draagt
        # daarna de zoektag van de tagvondst — het bewijs voor de accountregel.
        self.assertEqual(out["e"]["found_via"], "stelz")
        self.assertEqual(out["e"]["play_count"], 12000)
        self.assertIn("stelz", out["e"]["hashtags"])
        self.assertIn("fyp", out["e"]["hashtags"])

    def test_treffer_verdict_wint_van_onbeoordeeld(self):
        grp = [{"kind": "tiktok", "e": TT_PROFIEL, "v": None},
               {"kind": "discovery", "e": TT_TAG, "v": {"detected": True}}]
        out = F.merge_group(grp, self.RANK)
        self.assertEqual(out["kind"], "discovery")
        self.assertTrue(out["v"]["detected"])

    def test_cijfers_vullen_ook_de_andere_kant_op(self):
        grp = [{"kind": "discovery", "e": IG_TAG, "v": {"detected": True}},
               {"kind": "ig-posts", "e": IG_PROFIEL, "v": None}]
        out = F.merge_group(grp, self.RANK | {"ig-posts": 0})
        self.assertEqual(out["e"]["likes_count"], 38)
        self.assertEqual(out["e"]["found_via"], "lowlands2026")


class TestReuse(unittest.TestCase):
    """74's hergebruik, tegen echte bestanden onder een wegwerp-event."""

    EV = {"id": "unittest-dedupe"}

    def setUp(self):
        self.A = _load("_analyse74", "74_analyse.py")
        self.base = ROOT / ".tmp" / "events" / self.EV["id"]
        shutil.rmtree(self.base, ignore_errors=True)
        d = self.base / "discovery"
        d.mkdir(parents=True)
        (d / "index.jsonl").write_text(json.dumps(TT_TAG) + "\n")
        (d / "verdicts.jsonl").write_text(json.dumps(
            {"item_id": "7676", "detected": True, "confidence": 0.9,
             "context": "blikje in de hand", "max_dim": 0}) + "\n")

    def tearDown(self):
        shutil.rmtree(self.base, ignore_errors=True)

    def test_kopieert_bestaand_oordeel_in_plaats_van_gemini(self):
        verdicts: dict[str, dict] = {}
        copied = self.A.reuse_sibling_verdicts(
            self.EV, "tiktok", "video_id", [dict(TT_PROFIEL)], verdicts, 0)
        self.assertEqual(copied, 1)
        v = verdicts["7676"]
        self.assertTrue(v["detected"])
        # Geleend oordeel blijft herkenbaar als geleend.
        self.assertEqual(v["copied_from"], "discovery")

    def test_andere_resolutie_wordt_niet_geleend(self):
        # Een 512px-oordeel in een 0px-archief is precies het gemengde archief
        # dat 74 weigert — dan liever nog een keer betalen.
        verdicts: dict[str, dict] = {}
        copied = self.A.reuse_sibling_verdicts(
            self.EV, "tiktok", "video_id", [dict(TT_PROFIEL)], verdicts, 512)
        self.assertEqual(copied, 0)
        self.assertEqual(verdicts, {})

    def test_identiteit_spiegelt_72(self):
        # Als deze twee ooit uiteenlopen voegt 72 samen wat 74 dubbel betaalde.
        for e, kind, surf, raw in ((TT_PROFIEL, "tiktok", "tiktok", "7676"),
                                   (TT_TAG, "discovery", "tiktok", "7676"),
                                   (IG_PROFIEL, "ig-posts", "post", "DcXs0"),
                                   (IG_TAG, "discovery", "post", "igDcXs0")):
            self.assertEqual(self.A.content_identity(e, kind),
                             F.content_key(e, surf, kind, raw),
                             f"identiteit wijkt af voor {kind}")


if __name__ == "__main__":
    unittest.main()
