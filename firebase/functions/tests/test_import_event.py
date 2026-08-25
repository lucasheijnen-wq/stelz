"""Event import — the id contract and the timestamp conversion.

The uploader (tools/78_upload_event.py) and the handler (import_event.py)
bridge the locally harvested campaign into production. Two things can go
quietly wrong, and both tests exist because they would be invisible on screen
until someone counts:

  1. IDS. A carousel slide's doc id must share its first two `_`-segments with
     its siblings (parentPostKey is what collapses them in the live feed), and
     stories must match scan_stories' scheme EXACTLY (instagram_story{id}, no
     separator) or the same story imported and re-scanned becomes two docs.
  2. TIMESTAMPS. postedAt arrives as an ISO string (JSON has no other way);
     stored as a string it silently falls out of every postedAt-ordered query
     in the app — the feed would simply never show imported rows.
"""
from __future__ import annotations

import datetime as dt
import importlib.util
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

from handlers import import_event  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))))
_uspec = importlib.util.spec_from_file_location(
    "_upload78", os.path.join(ROOT, "tools", "stelz_brand_watch", "78_upload_event.py"))
U = importlib.util.module_from_spec(_uspec)
_uspec.loader.exec_module(U)


class TestUploaderIds(unittest.TestCase):
    def test_carousel_slides_share_their_first_two_segments(self):
        a = U.post_doc_id({"surface": "post", "itemId": "instagram_postDcXs0",
                           "postKey": "DcX", "slot": 0, "slots": 3})
        b = U.post_doc_id({"surface": "post", "itemId": "instagram_postDcXs2",
                           "postKey": "DcX", "slot": 2, "slots": 3})
        self.assertNotEqual(a, b)
        self.assertEqual(a.split("_")[:2], b.split("_")[:2],
                         "parentPostKey moet dia's tot één post collapsen")

    def test_single_post_and_tiktok_are_two_segments(self):
        self.assertEqual(
            U.post_doc_id({"surface": "post", "itemId": "instagram_postDcY",
                           "postKey": "DcY", "slot": None, "slots": 1}),
            "instagram_DcY")
        self.assertEqual(
            U.post_doc_id({"surface": "tiktok", "itemId": "tiktok_video712",
                           "postKey": "712"}),
            "tiktok_712")

    def test_story_matches_the_production_scheme_exactly(self):
        # scan_stories writes instagram_story{id} with NO separator, on
        # purpose (its own tests pin two segments). The import must land the
        # same story on the same doc.
        self.assertEqual(
            U.post_doc_id({"surface": "story", "itemId": "instagram_story397014"}),
            "instagram_story397014")

    def test_post_doc_carries_the_event_join_keys(self):
        doc = U.to_post_doc({
            "itemId": "instagram_postDcXs0", "surface": "post",
            "platform": "instagram", "creatorHandle": "anna",
            "platformHandle": "anna", "foundVia": "lowlands2026",
            "scrapedFor": None, "postKey": "DcX", "slot": 0, "slots": 3,
            "postedAt": "2026-08-22T08:10:24.000Z", "hashtags": ["lowlands"],
            "mentions": [], "views": None, "likes": 38,
        }, "lowlands-2026")
        # The fields the live event fetcher and matchEvent read back.
        self.assertEqual(doc["eventId"], "lowlands-2026")
        self.assertEqual(doc["itemId"], "instagram_postDcXs0")
        self.assertEqual(doc["foundVia"], "lowlands2026")
        self.assertEqual(doc["postKey"], "DcX")
        self.assertEqual(doc["likesCount"], 38)

    def test_detection_doc_id_is_deterministic(self):
        d = {"detection_id": "preview_post_DcXs0", "post_id": "instagram_postDcXs0",
             "detected": True}
        id1, _ = U.to_detection_doc(d, "lowlands-2026", {})
        id2, _ = U.to_detection_doc(d, "lowlands-2026", {})
        self.assertEqual(id1, id2)
        self.assertEqual(id1, "evt_post_DcXs0")


class TestHandlerRows(unittest.TestCase):
    def test_iso_timestamps_become_datetimes(self):
        cleaned = import_event._clean_doc({
            "postedAt": "2026-08-22T08:10:24.000Z",
            "expiresAt": None,
            "likesCount": 38,
        })
        self.assertIsInstance(cleaned["postedAt"], dt.datetime)
        self.assertIsNone(cleaned["expiresAt"])
        self.assertEqual(cleaned["likesCount"], 38)

    def test_row_cap_is_enforced(self):
        rows = [{"id": f"p{i}", "data": {}} for i in range(import_event.MAX_ROWS + 1)]
        with mock.patch.object(import_event, "fs"):
            with self.assertRaises(ValueError):
                import_event.run("stelz", {"action": "rows", "posts": rows})

    def test_unknown_action_refuses(self):
        with self.assertRaises(ValueError):
            import_event.run("stelz", {"action": "??"})

    def test_media_is_content_addressed(self):
        import base64
        uploads: dict[str, bytes] = {}

        class Blob:
            def __init__(self, path):
                self.path = path
                self.public_url = f"https://storage/{path}"

            def exists(self):
                return self.path in uploads

            def upload_from_string(self, raw, content_type):
                uploads[self.path] = raw

            def make_public(self):
                pass

        fake_fs = types.SimpleNamespace(
            bucket=lambda: types.SimpleNamespace(blob=lambda path: Blob(path)))
        with mock.patch.object(import_event, "fs", fake_fs):
            body = {"action": "media",
                    "b64": base64.b64encode(b"pixels").decode(),
                    "contentType": "image/jpeg"}
            out1 = import_event.run("stelz", body)
            out2 = import_event.run("stelz", body)
        self.assertEqual(out1["url"], out2["url"],
                         "zelfde bytes → zelfde pad; herdraaien uploadt niets opnieuw")
        self.assertEqual(len(uploads), 1)


if __name__ == "__main__":
    unittest.main()
