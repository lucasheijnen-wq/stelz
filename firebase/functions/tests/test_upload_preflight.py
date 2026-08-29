"""78_upload_event: what happens when production is not what it claims.

WHY THIS EXISTS. api_import_event was merged but never deployed, and the upload
step found that out the expensive way: it streamed 81 MB of base64 media at a
404, the server hung up mid-send, and the only output was an unhandled
BrokenPipeError traceback — a red round with no clue in it. Two rules fix that
and are pinned here:

  1. A PREFLIGHT goes first: one empty rows-batch (a valid call that writes
     nothing) proves the endpoint exists and the token works BEFORE any media
     leaves the machine.
  2. call_api never lets a network failure escape as a traceback. A 404 names
     the actual fix (deploy the functions); a dropped connection says the retry
     is safe. Both are SystemExit with a message, not a stack dump.

urllib is mocked throughout — no test here touches the network.
"""
from __future__ import annotations

import importlib.util
import io
import json
import sys
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[3]
_spec = importlib.util.spec_from_file_location(
    "_upload_event", ROOT / "tools" / "stelz_brand_watch" / "78_upload_event.py")
M = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(M)


def http_error(code: int, body: bytes = b"") -> urllib.error.HTTPError:
    return urllib.error.HTTPError("url", code, "msg", hdrs=None, fp=io.BytesIO(body))


class TestCallApi(unittest.TestCase):
    def _call(self, effect):
        with mock.patch.object(M.urllib.request, "urlopen", side_effect=effect):
            return M.call_api("https://x", "tok", {"action": "rows"})

    def test_a_404_names_the_fix_not_the_symptom(self):
        with self.assertRaises(SystemExit) as ctx:
            self._call(http_error(404))
        msg = str(ctx.exception)
        self.assertIn("nooit uitgerold", msg)
        self.assertIn("firebase deploy --only functions", msg)
        # And it must say the harvest itself is fine — a deploy problem must
        # not read as a broken scrape.
        self.assertIn("blijft elke ronde lokaal", msg)

    def test_a_dropped_connection_is_a_message_not_a_traceback(self):
        # BrokenPipeError is what the server hanging up mid-send raises; it is
        # a ConnectionError subclass and used to escape unhandled.
        with self.assertRaises(SystemExit) as ctx:
            self._call(BrokenPipeError(32, "Broken pipe"))
        self.assertIn("upload afgebroken", str(ctx.exception))
        self.assertIn("Herdraaien is veilig", str(ctx.exception))

    def test_a_url_error_is_covered_too(self):
        with self.assertRaises(SystemExit) as ctx:
            self._call(urllib.error.URLError("no route to host"))
        self.assertIn("upload afgebroken", str(ctx.exception))

    def test_auth_errors_keep_their_specific_message(self):
        with self.assertRaises(SystemExit) as ctx:
            self._call(http_error(401))
        self.assertIn("token verlopen of geen member", str(ctx.exception))

    def test_a_success_still_returns_the_json(self):
        resp = mock.MagicMock()
        resp.read.return_value = json.dumps({"posts": 0, "detections": 0}).encode()
        resp.__enter__ = lambda s: resp
        resp.__exit__ = lambda s, *a: False
        with mock.patch.object(M.urllib.request, "urlopen", return_value=resp):
            out = M.call_api("https://x", "tok", {"action": "rows"})
        self.assertEqual(out, {"posts": 0, "detections": 0})


class TestPreflightGoesFirst(unittest.TestCase):
    """The 404 must land BEFORE any media call — that ordering is the fix.

    Real fixture files in a temp TMP, a real event definition, and only
    call_api faked: the run is main() as it actually executes, so a refactor
    that moves the preflight behind the media loop fails this test rather than
    slipping past a mock that no longer matches the code."""

    def _run_main(self):
        import tempfile
        calls: list[dict] = []

        def fake_call_api(base, token, body):
            calls.append(body)
            if body.get("action") == "rows" and not body.get("posts"):
                raise SystemExit(M.NOT_DEPLOYED_MSG)   # endpoint bestaat niet
            raise AssertionError("a media call went out before the preflight failed")

        with tempfile.TemporaryDirectory() as tmp:
            tmpdir = Path(tmp)
            (tmpdir / "preview-campaign.json").write_text(json.dumps([
                {"itemId": "x", "surface": "post", "platform": "instagram",
                 "postedAt": "2026-08-21T12:00:00.000Z", "postKey": "x"},
            ]))
            (tmpdir / "preview-campaign-detections.json").write_text(json.dumps([
                {"detection_id": "d1", "post_id": "x", "detected": True,
                 "image_url": "/preview-media/lowlands-2026/ig-posts/x.jpg"},
            ]))
            argv = ["78_upload_event.py", "--event", "lowlands-2026",
                    "--token", "tok-abc"]
            with mock.patch.object(M, "call_api", fake_call_api), \
                 mock.patch.object(sys, "argv", argv), \
                 mock.patch.object(M, "TMP", tmpdir), \
                 mock.patch.object(M, "media_path_for", lambda u: None):
                with self.assertRaises(SystemExit) as ctx:
                    M.main()
        return calls, ctx.exception

    def test_the_preflight_is_the_first_and_only_call(self):
        calls, exc = self._run_main()
        self.assertEqual(len(calls), 1, "more than the preflight went out")
        self.assertEqual(calls[0]["action"], "rows")
        self.assertEqual(calls[0]["posts"], [])
        self.assertEqual(calls[0]["detections"], [])
        self.assertIn("nooit uitgerold", str(exc))


class TestTokenIsAlwaysBurned(unittest.TestCase):
    """The refresh token must not outlive the round that carried it.

    It used to be unlinked as the LAST statement of main(), so every failure
    path left it on disk: the 404 preflight, a 401, a dropped connection,
    id_token_from_refresh raising. 79_verversronde.sh then calls step 78 with
    --if-authed and no --token-file on the NEXT round, resolve_token finds the
    leftover file (it only checks that the path exists — no freshness, no
    ownership), exchanges it, and uploads to production under the previous
    user, while the button that started the round says "niet ingelogd, dus
    deze ronde blijft lokaal".
    """

    def setUp(self):
        import tempfile
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.token_file = Path(self.dir.name) / "scrape-auth-lowlands-2026.json"
        self.token_file.write_text(json.dumps({"refreshToken": "secret"}))

    def test_a_successful_round_removes_it(self):
        M._discard_token(self.token_file)
        self.assertFalse(self.token_file.exists())

    def test_a_failed_round_removes_it_too(self):
        # The scenario: main() left by SystemExit from the 404 preflight. The
        # finally-block still runs, which is the whole point of the change.
        try:
            try:
                raise SystemExit(2)
            finally:
                M._discard_token(self.token_file)
        except SystemExit:
            pass
        self.assertFalse(self.token_file.exists())

    def test_no_token_file_is_not_an_error(self):
        M._discard_token(None)
        M._discard_token(Path(self.dir.name) / "nope.json")

    def test_an_undeletable_file_does_not_crash_the_round(self):
        with mock.patch.object(Path, "unlink", side_effect=OSError("read-only")):
            M._discard_token(self.token_file)  # must not raise

    def test_main_publishes_the_path_it_resolved(self):
        # The finally-block reads it off the module, so main() must set it
        # BEFORE anything that can exit — otherwise the cleanup has nothing to
        # act on precisely on the paths that need it most.
        src = (ROOT / "tools" / "stelz_brand_watch" / "78_upload_event.py").read_text()
        resolve_at = src.index("token, token_path = resolve_token(args)")
        publish_at = src.index("RESOLVED_TOKEN_PATH = token_path")
        first_exit_after = src.index("return 2", resolve_at)
        self.assertLess(resolve_at, publish_at)
        self.assertLess(publish_at, first_exit_after)


if __name__ == "__main__":
    unittest.main(verbosity=2)
