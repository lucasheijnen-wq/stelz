"""Scan progress — what the UI subscribes to while a scan runs.

The progress plumbing already existed and worked (a `scan` map on the brand
doc, onSnapshot in the client, Increment counters, a finally-guaranteed bump).
It modelled a ONE-step scan while Run scan actually runs seven, so the pill
said "done" the moment the last hashtag worker returned and the remaining five
steps ran invisibly — and when one of them failed, nothing anywhere recorded
it.

This module adds a per-step map beside the existing flat fields. The flat
fields are kept verbatim: the current pill reads them, and a frontend that
predates the steps map must keep working against a backend that has it.

Every function swallows its own exceptions. Progress reporting is decoration;
it must never be the reason a scan fails.
"""
from __future__ import annotations

import logging
from typing import Any

from google.cloud.firestore import SERVER_TIMESTAMP, Increment

from lib import fs

log = logging.getLogger(__name__)

# Every step Run scan can execute, in the order the UI lists them.
STEPS = ("hashtags", "creators", "stories", "profiles", "subcultures", "srs", "sentiment")

# ── The detect counters live in a SHARDED subcollection ──────────────────
#
# They used to be three Increments on the brand document itself, written once
# per detect message. A festival scan is ~9.500 of those, arriving from up to
# 75 containers at once (detect-image runs concurrency=1, max_instances=50;
# detect-video 25). Firestore sustains roughly ONE write per second to a single
# document, and every writer beyond that contends — bump_detect_progress
# catches its own failure and only logs it, so a lost increment is permanent
# and invisible.
#
# That is what "9290 van 9573" was: not 283 dead workers, but 283 counter
# writes that lost a fight over one document. The panel then reported it as
# "de analyse-workers schrijven al uren niets meer", because the same lost
# write also carried lastActivityAt — the heartbeat corroborated a story it
# had itself caused.
#
# Twenty shards turn one hot document into twenty cool ones. The client sums
# them and ADDS the flat counter, so a session written by the old code still
# reads correctly: its shards are empty and the flat value stands.
SHARD_COLLECTION = "scanShards"
SHARD_COUNT = 20


def _shard_id() -> str:
    """Pick a shard at random rather than by post id.

    By-id would be stable, which sounds tidier and is worse: an image and its
    video share a post id, and a carousel's slides differ only in a suffix, so
    a burst from one post would pile onto one shard — exactly the contention
    this exists to spread.
    """
    import random
    return f"s{random.randrange(SHARD_COUNT)}"


def _sanitize_counts(d: dict[str, Any] | None) -> dict[str, Any]:
    """Handler return dicts go straight to the client, so keep them to
    primitives — a stray object would fail the Firestore write and take the
    step's completion with it."""
    out: dict[str, Any] = {}
    for k, v in (d or {}).items():
        if isinstance(v, (str, int, float, bool)) and not isinstance(v, bytes):
            out[str(k)[:60]] = v
    return out


def step_started(brand_id: str, step: str) -> None:
    try:
        # update() with a dotted path REPLACES the whole step map, which is what
        # clears a previous run's counts and error. set(merge=True) would leave
        # last week's failure sitting under a green step.
        fs.brand_doc(brand_id).update({
            f"scan.steps.{step}": {
                "state": "running",
                "startedAt": SERVER_TIMESTAMP,
                "finishedAt": None,
                "error": None,
                "counts": {},
            },
            "scan.lastActivityAt": SERVER_TIMESTAMP,
        })
    except Exception:
        log.exception(f"[{brand_id}] step_started({step}) failed")


def step_finished(brand_id: str, step: str, counts: dict[str, Any] | None = None) -> None:
    try:
        fs.brand_doc(brand_id).update({
            f"scan.steps.{step}.state": "done",
            f"scan.steps.{step}.finishedAt": SERVER_TIMESTAMP,
            f"scan.steps.{step}.counts": _sanitize_counts(counts),
            "scan.lastActivityAt": SERVER_TIMESTAMP,
        })
    except Exception:
        log.exception(f"[{brand_id}] step_finished({step}) failed")


def step_skipped(brand_id: str, step: str, reason: str,
                 counts: dict[str, Any] | None = None) -> None:
    """The handler ran, refused, and said why.

    Distinct from 'done' (it did the work) and from 'error' (something broke).
    A budget gate turning a scan away is a normal, expected outcome — but it
    was being painted green, so a brand whose daily budget was exhausted
    looked fully scanned every day while nothing was scraped at all.
    """
    try:
        fs.brand_doc(brand_id).update({
            f"scan.steps.{step}.state": "skipped",
            f"scan.steps.{step}.error": reason[:300],
            f"scan.steps.{step}.finishedAt": SERVER_TIMESTAMP,
            f"scan.steps.{step}.counts": _sanitize_counts(counts),
            "scan.lastActivityAt": SERVER_TIMESTAMP,
        })
    except Exception:
        log.exception(f"[{brand_id}] step_skipped({step}) failed")


def step_failed(brand_id: str, step: str, error: str) -> None:
    try:
        fs.brand_doc(brand_id).update({
            f"scan.steps.{step}.state": "error",
            f"scan.steps.{step}.error": str(error)[:300],
            f"scan.steps.{step}.finishedAt": SERVER_TIMESTAMP,
            "scan.lastActivityAt": SERVER_TIMESTAMP,
        })
    except Exception:
        log.exception(f"[{brand_id}] step_failed({step}) failed")


def session_open(brand_id: str) -> None:
    """Start a scan SESSION — the flat `scan.startedAt`/`finishedAt` pair.

    Until this existed, exactly one code path wrote those two fields:
    scan_hashtags.publish_tags. Everything else — including step_started above
    — wrote only `scan.steps.{step}`. The brand-wide Run scan got away with it
    because it awaits fbStepHashtags() first, so a session was always open by
    the time the other steps ran. The EVENT button does not call hashtags at
    all (the checkbox defaults off), so for an event scan the pair never moved,
    and three things followed from that one gap:

      · ScanPanel returns null on phase 'idle', and scanPhase is 'idle'
        whenever startedAt is unset — so the progress panel the button's own
        tooltip points at stayed unmounted for the whole scan.
      · Event.tsx reloads the campaign on the running -> finished transition.
        `running` was never true, so the transition never happened and the page
        kept showing pre-scan rows after a successful scan. That is the exact
        complaint the button was built to answer.
      · `running` also gates the button. False means a second press — or a page
        refresh mid-scan — starts another paid Apify scrape.

    Counters are reset here, not merged. A session that inherited last week's
    detectTasksEnqueued reported completions against a stale denominator and
    computed its ETA from a startedAt seven days old.
    """
    try:
        fs.brand_doc(brand_id).set({
            "scan": {
                "startedAt": SERVER_TIMESTAMP,
                "finishedAt": None,
                "hashtagQueued": 0,
                "hashtagDone": 0,
                "postsWritten": 0,
                "detectTasksEnqueued": 0,
                "detectionsCompleted": 0,
                "detectionsHit": 0,
                "skippedCount": 0,
                "endReason": None,
                "tags": [],
                "lastActivityAt": SERVER_TIMESTAMP,
            }
        }, merge=True)
        # The shards are part of the same counters, so they reset with them.
        # Twenty deletes, and a failure here is not fatal: a leftover shard
        # inflates the next session's completions, which the client clamps to
        # the denominator — visibly wrong, but it cannot break a scan.
        for snap in fs.brand_doc(brand_id).collection(SHARD_COLLECTION).stream():
            snap.reference.delete()
    except Exception:
        log.exception(f"[{brand_id}] session_open failed")


def session_close(brand_id: str, end_reason: str | None = None) -> None:
    """Close the session opened above. Safe to call twice."""
    try:
        fs.brand_doc(brand_id).set({
            "scan": {
                "finishedAt": SERVER_TIMESTAMP,
                "endReason": end_reason,
                "lastActivityAt": SERVER_TIMESTAMP,
            }
        }, merge=True)
    except Exception:
        log.exception(f"[{brand_id}] session_close failed")


def session_is_open(brand_id: str) -> bool:
    """Is a scan session running right now?

    Guards the detect-denominator bumps. A scan that runs with no session open
    (a scheduled sweep, or a step fired straight from the API) used to
    Increment detectTasksEnqueued on whatever block was left on the brand doc,
    so a finished session from last week gained a bigger denominator than its
    frozen completions — the panel snapped back to 'analysing' and printed an
    ETA measured from a week-old startedAt.
    """
    try:
        snap = fs.brand_doc(brand_id).get()
        scan = (snap.to_dict() or {}).get("scan") or {}
        return bool(scan.get("startedAt")) and not scan.get("finishedAt")
    except Exception:
        log.exception(f"[{brand_id}] session_is_open failed")
        return False


def bump_enqueued(brand_id: str, n: int) -> None:
    """Add to the analysis denominator. For resume_analysis, which publishes
    detect work outside the scrapers' own fan-out."""
    if n <= 0:
        return
    try:
        fs.brand_doc(brand_id).set({
            "scan": {
                "detectTasksEnqueued": Increment(n),
                "lastActivityAt": SERVER_TIMESTAMP,
            }
        }, merge=True)
    except Exception:
        log.exception(f"[{brand_id}] bump_enqueued failed")


def bump_detect_progress(brand_id: str, hit: bool, skipped: bool = False) -> None:
    """One detect message processed. Called from a finally on EVERY terminal
    path, including the expected ones (an expired Instagram CDN URL is a normal
    outcome, not an anomaly) — previously only the write-a-detection path
    bumped, so the "analysing" bar could never reach 100% on any scan that had
    a single stale URL in it.

    lastActivityAt rides the same write: without it the client's 5-minute stall
    detector saw a frozen heartbeat all through a healthy detect phase and
    reported a working scan as dead.
    """
    try:
        fs.brand_doc(brand_id).collection(SHARD_COLLECTION).document(_shard_id()).set({
            "detectionsCompleted": Increment(1),
            "detectionsHit": Increment(1 if hit else 0),
            "skippedCount": Increment(1 if skipped else 0),
            "lastActivityAt": SERVER_TIMESTAMP,
        }, merge=True)
    except Exception:
        log.exception(f"[{brand_id}] bump_detect_progress failed")
