#!/usr/bin/env python3
"""One hardened media downloader for every archive script.

    import importlib.util, pathlib
    _spec = importlib.util.spec_from_file_location(
        "_fetch", pathlib.Path(__file__).with_name("_fetch.py"))
    F = importlib.util.module_from_spec(_spec); _spec.loader.exec_module(F)

    F.download(url, dest)                      # bytes written, or 0
    F.download(url, dest, read_timeout=120, min_bytes=10_000)
    F.prefetch([(url, dest), ...])             # concurrent warm-up

WHAT THIS REPLACED
------------------
Four near-identical copies of the same eight lines: 62_stories_archive,
71_ig_posts_archive, and twice in 70_tiktok_archive (which 73 imports). Each
had its own timeout — 60, 90, 90, 120 — and each had the same three bugs.

THE BUG, MEASURED
-----------------
One refresh round spent 29 minutes 17 seconds in 71_ig_posts_archive. Twenty of
those minutes were a single Instagram carousel whose twenty slides all lived on
`instagram.ftrc1-1.fna.fbcdn.net`, a host that had gone dark. Timed against the
real host: it accepts nothing and raises ConnectTimeout after ~75 seconds.

Three things turned one dead host into half an hour, and all three are fixed
here rather than in four places:

1. ONE TIMEOUT FOR TWO DIFFERENT WAITS. `requests.get(url, timeout=90)` applies
   that number to BOTH the connect and the read, so a host that never answers
   burns the full 90 seconds that was meant for pulling a large video. Connect
   and read are split below: five seconds to answer at all, a minute to deliver.

2. NO MEMORY. After the first timeout the host is known to be unreachable, and
   the next nineteen URLs on that same host each paid the full price again. A
   host that fails to connect twice is skipped for the rest of the run.

3. ONE AT A TIME. The archive loops download sequentially, so every one of those
   waits was wall-clock the whole round stood still for. prefetch() pulls a
   batch concurrently; because download() returns early for a file already on
   disk, the caller's existing sequential loop then costs nothing and its
   bookkeeping does not have to change at all.

A dead link is expected, not exceptional — these are signed CDN URLs and some
are stale before we reach them. What is NOT acceptable is being slow about it.

WHY THE ERRORS GOT LONGER
-------------------------
The old callers printed `str(e)[:70]`, which cut a urllib3 message off at
`HTTPSConnectionPool(host='...', port=443):` — exactly one character before the
word that says what went wrong. The log recorded twenty failures and not one
clue that they were timeouts. The exception TYPE now leads the line.
"""
from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import urlparse

import requests

# Seconds to get a connection at all. A reachable CDN answers in well under one;
# anything that needs more than five is not going to serve us a photo.
CONNECT_TIMEOUT = 5
# Seconds to deliver the body once connected. This is the number the old scalar
# timeout was actually chosen for.
READ_TIMEOUT = 60
# Videos are megabytes rather than kilobytes and TikTok throttles them.
VIDEO_READ_TIMEOUT = 120

# Consecutive connect/read failures before a host is written off for this run.
# Two, not one: a single timeout can be a blip on a host that is otherwise fine,
# and writing off a live CDN would silently cost us media. Two in a row on the
# same host is a pattern, and the twenty-slide carousel proves how expensive
# waiting for the third is.
DEAD_AFTER = 2

# Parallel downloads. Six matches 74_analyse's concurrency: enough to hide the
# latency of one slow CDN, low enough that a roster scrape does not look like a
# denial-of-service attempt to Instagram.
PREFETCH_WORKERS = 6

UA = {"User-Agent": "Mozilla/5.0"}

# Failures that say something about the HOST (it is unreachable or too slow).
# An HTTPError is deliberately NOT one: a 403 on a signed URL means the host
# answered promptly and this particular link is stale, which is the normal case
# and must never take a working CDN out of the run.
_HOST_ERRORS = (requests.exceptions.ConnectTimeout,
                requests.exceptions.ReadTimeout,
                requests.exceptions.ConnectionError)

_print_lock = threading.Lock()


def _say(line: str) -> None:
    """Printing from prefetch's threads, one whole line at a time."""
    with _print_lock:
        print(line, flush=True)


class DeadHosts:
    """Which hosts have stopped answering, counted per run.

    Thread-safe because prefetch() calls into it from a pool — and because the
    whole point is that thread B learns from thread A's timeout instead of
    repeating it.
    """

    def __init__(self, dead_after: int = DEAD_AFTER):
        self._dead_after = dead_after
        self._lock = threading.Lock()
        self._fails: dict[str, int] = {}

    def is_dead(self, host: str) -> bool:
        with self._lock:
            return self._fails.get(host, 0) >= self._dead_after

    def failed(self, host: str) -> bool:
        """Record a host-level failure. True if that just killed the host."""
        with self._lock:
            self._fails[host] = self._fails.get(host, 0) + 1
            return self._fails[host] == self._dead_after

    def alive(self, host: str) -> None:
        """The host answered — including with a 404. Forget earlier blips, so a
        long run is not eventually killed by failures scattered across hours."""
        with self._lock:
            self._fails.pop(host, None)

    def reset(self) -> None:
        with self._lock:
            self._fails.clear()


HOSTS = DeadHosts()


def host_of(url: str) -> str:
    try:
        return (urlparse(url).hostname or "").lower()
    except ValueError:
        return ""


def download(url: str | None, dest: Path, *,
             read_timeout: int = READ_TIMEOUT, min_bytes: int = 0,
             quiet: bool = False) -> int:
    """Bytes written, or 0. Never raises: a failed download is data we do not
    have, not a reason to abandon a harvest that is mostly working.

    `min_bytes` rejects a body too small to be the thing we asked for — TikTok
    answers a throttled video request with a short error page rather than an
    error status.
    """
    if not url:
        return 0
    if dest.exists() and dest.stat().st_size > 0:
        return dest.stat().st_size

    host = host_of(url)
    if HOSTS.is_dead(host):
        # The whole saving: no socket, no wait.
        return 0

    try:
        r = requests.get(url, timeout=(CONNECT_TIMEOUT, read_timeout), headers=UA)
        r.raise_for_status()
    except _HOST_ERRORS as e:
        if HOSTS.failed(host) and not quiet:
            _say(f"    ✕ {host} reageert niet — rest van deze host overgeslagen")
        if not quiet:
            _say(f"    ✕ {dest.name}: {type(e).__name__}")
        return 0
    except Exception as e:
        # The host answered, so it stays in play; this link is just no good.
        HOSTS.alive(host)
        if not quiet:
            _say(f"    ✕ {dest.name}: {type(e).__name__}: {str(e)[:90]}")
        return 0

    HOSTS.alive(host)
    if len(r.content) < min_bytes:
        return 0
    dest.write_bytes(r.content)
    return len(r.content)


def prefetch(jobs, workers: int = PREFETCH_WORKERS) -> int:
    """Pull `jobs` — (url, dest) or (url, dest, read_timeout) — concurrently.

    Returns how many landed. Callers do not use the result for bookkeeping:
    they run their normal sequential loop afterwards, where download() finds the
    file already on disk and returns its size without touching the network. That
    is what makes this safe to bolt onto a loop that also writes an index — the
    ordering, the counters and the index stay exactly as they were.
    """
    todo = []
    for job in jobs:
        url, dest = job[0], job[1]
        rt = job[2] if len(job) > 2 else READ_TIMEOUT
        if not url or (dest.exists() and dest.stat().st_size > 0):
            continue
        todo.append((url, dest, rt))
    if not todo:
        return 0
    got = 0
    with ThreadPoolExecutor(max_workers=max(1, workers)) as ex:
        futures = [ex.submit(download, u, d, read_timeout=rt) for u, d, rt in todo]
        for f in futures:
            try:
                if f.result():
                    got += 1
            except Exception:
                # download() swallows its own errors; this is belt and braces.
                pass
    return got
