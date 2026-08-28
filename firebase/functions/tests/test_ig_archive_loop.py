"""71_ig_posts_archive's harvest loop, after it was split in two.

WHY THIS EXISTS. The loop used to do everything in one pass: filter a post,
write its raw payload, download its media, append to the index. To download
concurrently it had to become two passes — decide what survives the filters,
warm the media up six at a time, then do the bookkeeping. That is a rewrite of
the hot loop of a script that spends Apify money and appends to an archive index
nobody re-derives, so the things that must not have changed are pinned here:

  * which posts are skipped, and under which of the three counters;
  * that an item already in the index is not re-appended;
  * that a post whose media all failed leaves NO index row — a row pointing at
    files that do not exist is worse than no row, because the analyser would
    then read it as an item to judge and find nothing;
  * that the raw payload lands exactly once per surviving post.

Nothing here touches the network: `scrape` and the downloader are both stubbed.
"""
from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[3]
TOOLS = ROOT / "tools" / "stelz_brand_watch"
sys.path.insert(0, str(ROOT / "firebase" / "functions"))

_spec = importlib.util.spec_from_file_location(
    "_ig_posts_archive", TOOLS / "71_ig_posts_archive.py")
M = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(M)


def post(code: str, handle: str = "anna", when: str = "2026-08-21T12:00:00.000Z",
         children: int = 0, video: bool = False) -> dict:
    """An Apify Instagram payload, trimmed to the fields rows_for reads."""
    item = {
        "shortCode": code, "ownerUsername": handle, "timestamp": when,
        "inputUrl": f"https://www.instagram.com/{handle}/",
        "displayUrl": f"https://cdn.example/{code}.jpg",
        "caption": "", "hashtags": [], "mentions": [],
    }
    if video:
        item["videoUrl"] = f"https://cdn.example/{code}.mp4"
    if children:
        item["childPosts"] = [
            {"displayUrl": f"https://cdn.example/{code}s{i}.jpg"}
            for i in range(children)
        ]
    return item


class LoopCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.archive = Path(self._tmp.name)

        self.items: list[dict] = []
        # Every download "succeeds" by writing a byte, unless a url is in `dead`.
        self.dead: set[str] = set()
        self.fetched: list[str] = []

        def fake_download(url, dest, **kw):
            if not url:
                return 0
            self.fetched.append(url)
            if url in self.dead:
                return 0
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(b"x")
            return 1

        patches = [
            mock.patch.object(M, "token", lambda: "fake-token"),
            mock.patch.object(M, "scrape", lambda *a, **k: list(self.items)),
            mock.patch.object(M.E, "archive_dir", lambda ev, kind: self.archive),
            mock.patch.object(M.F, "download", fake_download),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def run_main(self, *argv) -> str:
        import io
        import contextlib
        args = ["71_ig_posts_archive.py", "--event", "lowlands-2026",
                "--handles", "anna", *argv]
        buf = io.StringIO()
        with mock.patch.object(sys, "argv", args), contextlib.redirect_stdout(buf):
            rc = M.main()
        self.assertEqual(rc, 0)
        return buf.getvalue()

    def index_rows(self) -> list[dict]:
        f = self.archive / "index.jsonl"
        if not f.exists():
            return []
        return [json.loads(l) for l in f.read_text().splitlines() if l.strip()]


class TestWhatLandsInTheIndex(LoopCase):
    def test_a_simple_post_writes_one_row_and_one_raw_payload(self):
        self.items = [post("AAA")]
        self.run_main()
        rows = self.index_rows()
        self.assertEqual([r["item_id"] for r in rows], ["AAA"])
        self.assertEqual(rows[0]["image_file"], "AAA.jpg")
        self.assertEqual(rows[0]["event"], "lowlands-2026")
        self.assertTrue((self.archive / "raw" / "AAA.json").exists())

    def test_a_carousel_writes_one_row_per_slide_in_order(self):
        self.items = [post("CAR", children=3)]
        self.run_main()
        self.assertEqual([r["item_id"] for r in self.index_rows()],
                         ["CARs0", "CARs1", "CARs2"])

    def test_the_raw_payload_is_written_once_per_post_not_per_slide(self):
        self.items = [post("CAR", children=3)]
        self.run_main()
        self.assertEqual(
            [p.name for p in (self.archive / "raw").iterdir()], ["CAR.json"])


class TestTheThreeCounters(LoopCase):
    def test_posts_older_than_since_are_counted_as_old_and_never_fetched(self):
        self.items = [post("OLD", when="2026-08-01T12:00:00.000Z"),
                      post("NEW", when="2026-08-21T12:00:00.000Z")]
        out = self.run_main("--since", "2026-08-20")
        self.assertEqual([r["item_id"] for r in self.index_rows()], ["NEW"])
        self.assertIn("1 older than --since", out)
        # The warm-up must respect the same cut-off, or the filter saves
        # bookkeeping while the bandwidth is spent anyway.
        self.assertNotIn("https://cdn.example/OLD.jpg", self.fetched)

    def test_an_item_already_in_the_index_is_skipped_not_duplicated(self):
        self.items = [post("AAA")]
        self.run_main()
        self.fetched.clear()
        out = self.run_main()                      # same post, second run
        self.assertEqual([r["item_id"] for r in self.index_rows()], ["AAA"])
        self.assertIn("1 already archived", out)
        self.assertEqual(self.fetched, [], "re-fetched an item already archived")

    def test_added_counts_what_reached_the_index(self):
        self.items = [post("A"), post("B"), post("C")]
        out = self.run_main()
        self.assertIn("+3 new", out)


class TestFailedMediaLeavesNoRow(LoopCase):
    def test_a_post_whose_media_failed_is_not_indexed(self):
        # A row pointing at files that do not exist is worse than no row: the
        # analyser would pick it up as something to judge and find nothing.
        self.items = [post("BAD")]
        self.dead = {"https://cdn.example/BAD.jpg"}
        out = self.run_main()
        self.assertEqual(self.index_rows(), [])
        self.assertIn("+0 new", out)

    def test_one_dead_slide_does_not_lose_the_others(self):
        self.items = [post("CAR", children=3)]
        self.dead = {"https://cdn.example/CARs1.jpg"}
        self.run_main()
        self.assertEqual([r["item_id"] for r in self.index_rows()],
                         ["CARs0", "CARs2"])

    def test_a_video_that_will_not_come_is_marked_rather_than_dropped(self):
        # The cover survives, so the row stays — but it has to SAY the clip was
        # not seen, or the analysis reports a cover-only verdict as if the whole
        # video had been watched.
        self.items = [post("VID", video=True)]
        self.dead = {"https://cdn.example/VID.mp4"}
        self.run_main()
        rows = self.index_rows()
        self.assertEqual(len(rows), 1)
        self.assertTrue(rows[0]["video_unavailable"])
        self.assertIsNone(rows[0]["video_file"])
        self.assertEqual(rows[0]["image_file"], "VID.jpg")


class TestTheWarmUp(LoopCase):
    def test_it_asks_for_exactly_what_the_loop_will_need(self):
        # The whole safety argument for bolting a concurrent prefetch in front
        # of an untouched sequential loop is that they agree on the file list.
        self.items = [post("A"), post("CAR", children=2), post("V", video=True)]
        real_prefetch = M.F.prefetch
        seen = {}

        def spy(jobs, **kw):
            jobs = list(jobs)
            seen["urls"] = {j[0] for j in jobs}
            return real_prefetch(jobs, **kw)

        with mock.patch.object(M.F, "prefetch", spy):
            self.run_main()

        self.assertEqual(seen["urls"], {
            "https://cdn.example/A.jpg",
            "https://cdn.example/CARs0.jpg",
            "https://cdn.example/CARs1.jpg",
            "https://cdn.example/V.jpg",
            "https://cdn.example/V.mp4",
        })

    def test_no_video_flag_keeps_videos_out_of_the_warm_up_too(self):
        self.items = [post("V", video=True)]
        seen = {}
        with mock.patch.object(M.F, "prefetch",
                               lambda jobs, **k: seen.setdefault("urls", {j[0] for j in jobs})):
            self.run_main("--no-video")
        self.assertEqual(seen["urls"], {"https://cdn.example/V.jpg"})


if __name__ == "__main__":
    unittest.main(verbosity=2)
