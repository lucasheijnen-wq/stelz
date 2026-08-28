"""The media downloader: how fast it gives up, and what it learns from failing.

WHY THIS FILE EXISTS. One refresh round spent 29 minutes 17 seconds in
71_ig_posts_archive. Twenty of those minutes were a single Instagram carousel
whose twenty slides all lived on one CDN host that had gone dark: each slide
waited out the full 90-second scalar timeout, one after another, and the round
stood still for all of it.

The three rules that stop that from costing half an hour again are the three
things tested here — the split timeout, the dead-host memory, and the fact that
a 404 is NOT evidence against a host. The last one is the dangerous one: get it
wrong in the other direction and a working CDN gets written off after two stale
links, and the harvest quietly loses media instead of quietly wasting time.
"""
from __future__ import annotations

import importlib.util
import re
import sys
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

# firebase/functions/tests/test_fetch.py → the repo root is four levels up.
ROOT = Path(__file__).resolve().parents[3]
_spec = importlib.util.spec_from_file_location(
    "_fetch", ROOT / "tools" / "stelz_brand_watch" / "_fetch.py")
F = importlib.util.module_from_spec(_spec)
sys.modules["_fetch"] = F
_spec.loader.exec_module(F)


def scalar_timeout_calls(src: str) -> list[str]:
    """Every `requests.get(...)` in `src` that passes a bare number as its
    timeout, minus the Apify API calls.

    Whole-text, not line-by-line: the calls that matter are written across
    several lines, and a per-line check reports a clean file no matter what is
    in it. One level of nested parentheses is enough for these call sites
    (`params={...}`, `f"{APIFY}/x"`), and a deeper one would fail loudly by not
    matching rather than quietly by matching the wrong span.

    Apify's own endpoints are excluded on purpose: that is a known-good host we
    WANT to wait on for five minutes while an actor run finishes. The rule is
    about MEDIA downloads from CDNs that may not answer at all.
    """
    calls = re.findall(r"requests\.get\((?:[^()]|\([^()]*\))*\)", src)
    out = []
    for c in calls:
        flat = " ".join(c.split())
        if re.search(r"timeout=\d", flat) and "APIFY" not in flat.upper():
            out.append(flat)
    return out


class _Handler(BaseHTTPRequestHandler):
    """/ok → 2 kB, /tiny → 12 bytes, anything else → 404."""

    def do_GET(self):  # noqa: N802
        if self.path == "/ok":
            body = b"x" * 2048
        elif self.path == "/tiny":
            body = b"too small"
        else:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


class ServerCase(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.srv = HTTPServer(("127.0.0.1", 0), _Handler)
        cls.base = f"http://127.0.0.1:{cls.srv.server_port}"
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def setUp(self):
        F.HOSTS.reset()
        import tempfile
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.d = Path(self._tmp.name)


class TestDownload(ServerCase):
    def test_writes_the_bytes(self):
        n = F.download(f"{self.base}/ok", self.d / "a.jpg")
        self.assertEqual(n, 2048)
        self.assertEqual((self.d / "a.jpg").stat().st_size, 2048)

    def test_a_file_already_on_disk_costs_no_request(self):
        # This is what makes prefetch() safe to bolt in front of the existing
        # sequential loop: the loop re-asks for every file and pays nothing.
        dest = self.d / "a.jpg"
        dest.write_bytes(b"y" * 10)
        self.srv.shutdown()  # nothing may reach the network from here on
        try:
            self.assertEqual(F.download(f"{self.base}/ok", dest), 10)
            self.assertEqual(dest.read_bytes(), b"y" * 10)
        finally:
            threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    def test_no_url_is_not_an_error(self):
        self.assertEqual(F.download(None, self.d / "a.jpg"), 0)
        self.assertEqual(F.download("", self.d / "a.jpg"), 0)

    def test_min_bytes_rejects_a_body_too_small_to_be_the_thing(self):
        # A throttled TikTok answers with a short error page and a 200.
        n = F.download(f"{self.base}/tiny", self.d / "v.mp4", min_bytes=10_000)
        self.assertEqual(n, 0)
        self.assertFalse((self.d / "v.mp4").exists())

    def test_a_404_leaves_no_file_behind(self):
        self.assertEqual(F.download(f"{self.base}/gone", self.d / "a.jpg"), 0)
        self.assertFalse((self.d / "a.jpg").exists())


class TestAStaleLinkIsNotADeadHost(ServerCase):
    def test_404s_never_write_off_a_working_host(self):
        # THE ONE THAT MUST NOT REGRESS. Signed CDN URLs go stale constantly, so
        # 404s arrive in runs. If they counted towards the dead-host rule, a
        # live CDN would be abandoned after two of them and every later slide
        # would be skipped without being tried — losing media silently, which is
        # worse than the slowness this whole file is about.
        host = F.host_of(f"{self.base}/gone")
        for i in range(6):
            F.download(f"{self.base}/gone", self.d / f"{i}.jpg")
        self.assertFalse(F.HOSTS.is_dead(host))
        # And the host still serves.
        self.assertEqual(F.download(f"{self.base}/ok", self.d / "good.jpg"), 2048)


class TestDeadHosts(unittest.TestCase):
    """The counting rule, without a network."""

    def setUp(self):
        self.h = F.DeadHosts(dead_after=2)

    def test_one_failure_is_a_blip_two_is_a_pattern(self):
        self.assertFalse(self.h.is_dead("cdn"))
        self.assertFalse(self.h.failed("cdn"))     # returns True only on the kill
        self.assertFalse(self.h.is_dead("cdn"))
        self.assertTrue(self.h.failed("cdn"))
        self.assertTrue(self.h.is_dead("cdn"))

    def test_the_kill_is_announced_exactly_once(self):
        # The caller prints on a True, and "host is dead" twenty times in a log
        # is noise that buries the twenty real lines.
        self.h.failed("cdn")
        self.assertTrue(self.h.failed("cdn"))
        self.assertFalse(self.h.failed("cdn"))
        self.assertFalse(self.h.failed("cdn"))

    def test_answering_forgets_earlier_blips(self):
        # A long run must not accumulate unrelated failures into a death.
        self.h.failed("cdn")
        self.h.alive("cdn")
        self.h.failed("cdn")
        self.assertFalse(self.h.is_dead("cdn"))

    def test_hosts_are_independent(self):
        self.h.failed("a"); self.h.failed("a")
        self.assertTrue(self.h.is_dead("a"))
        self.assertFalse(self.h.is_dead("b"))

    def test_counting_is_thread_safe(self):
        # prefetch calls in from a pool, and the whole point is that thread B
        # learns from thread A's timeout instead of repeating it.
        h = F.DeadHosts(dead_after=1000)
        def hammer():
            for _ in range(200):
                h.failed("cdn")
        ts = [threading.Thread(target=hammer) for _ in range(8)]
        for t in ts: t.start()
        for t in ts: t.join()
        self.assertEqual(h._fails["cdn"], 1600)


class TestTimeoutsAreSplit(unittest.TestCase):
    def test_connect_is_short_and_read_is_long(self):
        # The bug in one line: requests takes a scalar as BOTH, so the 90 that
        # was chosen for pulling a video became the wait for a host that never
        # answers. They are different numbers because they are different waits.
        self.assertLessEqual(F.CONNECT_TIMEOUT, 10)
        self.assertGreaterEqual(F.READ_TIMEOUT, 30)
        self.assertGreater(F.VIDEO_READ_TIMEOUT, F.READ_TIMEOUT)

    def test_no_archive_script_still_passes_a_scalar_timeout(self):
        # The four copies this replaced each had their own scalar. A new one
        # would reintroduce exactly the 29-minute round.
        tools = ROOT / "tools" / "stelz_brand_watch"
        offenders = []
        for name in ("62_stories_archive.py", "70_tiktok_archive.py",
                     "71_ig_posts_archive.py", "73_lowlands_discovery.py"):
            offenders += [f"{name}: {c}" for c in scalar_timeout_calls(
                (tools / name).read_text())]
        self.assertEqual(offenders, [], "media download with a scalar timeout")

    def test_the_guard_above_can_actually_fail(self):
        # A guard that cannot catch its own bug is worse than none, and the
        # first version of it could not: it matched line by line, so the real
        # multi-line `requests.get(\n  ..., timeout=60)` calls in 62 slipped
        # through and the check passed vacuously.
        self.assertEqual(
            scalar_timeout_calls('r = requests.get(url, timeout=90, headers=UA)'),
            ['requests.get(url, timeout=90, headers=UA)'])
        self.assertEqual(scalar_timeout_calls(
            'r = requests.get(\n    url,\n    timeout=90,\n)'), 
            ['requests.get( url, timeout=90, )'])
        # ...and that it still lets the two legitimate shapes past.
        self.assertEqual(scalar_timeout_calls(
            'r = requests.get(f"{APIFY}/runs",\n    params=p, timeout=60)'), [])
        self.assertEqual(scalar_timeout_calls(
            'r = requests.get(url, timeout=(CONNECT_TIMEOUT, read_timeout))'), [])


class TestPrefetch(ServerCase):
    def test_pulls_what_is_missing_and_skips_what_is_there(self):
        (self.d / "have.jpg").write_bytes(b"z" * 5)
        got = F.prefetch([
            (f"{self.base}/ok", self.d / "have.jpg"),   # already on disk
            (f"{self.base}/ok", self.d / "want1.jpg"),
            (f"{self.base}/ok", self.d / "want2.jpg"),
            (None, self.d / "none.jpg"),               # nothing to fetch
        ])
        self.assertEqual(got, 2)
        self.assertEqual((self.d / "have.jpg").read_bytes(), b"z" * 5)
        self.assertEqual((self.d / "want1.jpg").stat().st_size, 2048)
        self.assertFalse((self.d / "none.jpg").exists())

    def test_an_empty_batch_does_nothing(self):
        self.assertEqual(F.prefetch([]), 0)

    def test_one_bad_url_does_not_take_the_batch_down(self):
        got = F.prefetch([
            (f"{self.base}/gone", self.d / "a.jpg"),
            (f"{self.base}/ok", self.d / "b.jpg"),
        ])
        self.assertEqual(got, 1)
        self.assertEqual((self.d / "b.jpg").stat().st_size, 2048)


if __name__ == "__main__":
    unittest.main(verbosity=2)
