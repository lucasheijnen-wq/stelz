"""Per-brand daily usage tracking + budget guard.

Increment counters from each handler. Surfaced in the Settings → Usage card
on the UI. The guard degrades expensive work when the day's spend approaches
the brand's `dailyBudgetUsd` setting.

Counters tracked:
  apify_ig_results     — Instagram results returned by Apify (BILLED UNIT)
  apify_tt_results     — TikTok results returned by Apify
  apify_runs           — actor invocations (kept for visibility, NOT billed)
  gemini_flash_calls   — full Gemini Flash detection calls
  gemini_video_calls   — batched multi-frame video detection calls
  gemini_embed_calls   — Vertex multimodal embedding calls
  gemini_sentiment_calls — text-only post-sentiment classifications
  detections_written   — detection docs persisted
  detections_hit       — detection docs with detected=true

COST MODEL — corrected against measured billing, not guessed.

  Apify bills PER RESULT, not per run. `projects/spot-the-brand/operating-costs.md`
  records a real pilot month at "~17.000 results | $2.30 / 1k | ~€36", which
  reconciles exactly. The previous model here charged $0.10 per *run* and so
  under-reported Apify spend by roughly 11x. That mattered: with the UI's
  defaults (perTag=500, maxTags=50) a single "Run scan" click can pull 25,000
  results — about $57 — while this module reported $5.00.

  Gemini Flash is ~$0.00175/call, not $0.00075: every detect call ships 8
  reference images plus the target (9 x 258 = 2,322 image tokens) on top of a
  ~1,000-token prompt, at $0.30/1M in and $2.50/1M out.
"""
from __future__ import annotations
import logging
import time
from typing import Any

from google.cloud.firestore import Increment, SERVER_TIMESTAMP

from . import fs

log = logging.getLogger(__name__)

# USD per unit of the counter named. Only billed units belong here — note that
# `apify_runs` is deliberately absent: runs are free, results are what cost.
COST_PER_UNIT = {
    "apify_ig_results": 0.0023,   # $2.30 / 1k results — measured
    "apify_tt_results": 0.0000,   # clockworks free actor; set >0 if you move to the paid one
    # Stories (handlers/scan_stories.py). NOTE the run fee: this actor breaks
    # the "runs are free, results are what cost" rule that keeps apify_runs out
    # of this table, and it dominates the bill at our volume — which is exactly
    # why every handle goes into ONE run per sweep.
    "apify_story_runs": 0.099,        # $0.099 per actor start
    "apify_story_usernames": 0.003,   # + $3 / 1k usernames submitted
    "gemini_flash_calls": 0.00175,
    "gemini_video_calls": 0.00288,  # batched: 8 refs + 6 frames + prompt in ONE call
    "gemini_embed_calls": 0.00010,
    # Second-look verification (lib/verifier.py). Costlier per call than
    # detection because the image goes at 1024px rather than 512 — 4x the pixel
    # area, so ~4x the image tokens on the target (refs stay at 512). Fires only
    # on demoted hits, roughly 20% of hits, so the daily total is small.
    # MUST stay in this table: a billed unit that is missing here is invisible to
    # estimated_spend_today, which silently under-reports the degrade level and
    # lets a scan keep running past the budget it thinks it is under.
    "gemini_verify_calls": 0.00330,
    # Post sentiment (handlers/analyze_sentiment.py). Text-only — no reference
    # images, no target image — so it costs a fraction of a detect call: a
    # ~400-token prompt plus a short caption in, ~60 tokens out.
    "gemini_sentiment_calls": 0.00020,
}

DEFAULT_DAILY_BUDGET_USD = 5.0

# Degrade ladder. A hard stop mid-scan is the worst outcome — you have already
# paid Apify for posts that then never get analysed. So we throttle the INPUTS
# (fewer tags, shallower scrapes, fewer frames) and let anything already
# scraped finish being detected.
DEGRADE_NORMAL = 0        # < 70%  — full speed
DEGRADE_TRIM = 1          # 70-85% — drop lifestyle families, halve perTag, 6->4 frames
DEGRADE_BRAND_ONLY = 2    # 85-95% — brand tags + creator deep-scan only, 3 frames
DEGRADE_NO_SCRAPE = 3     # 95-100% — stop new scraping, keep detecting what we have
DEGRADE_CACHE_ONLY = 4    # > 100% — cache-hit detections only (free)

# Guard reads the usage doc on every detect message otherwise, which would add
# one Firestore read and a round-trip per fan-out message (tens of thousands
# per scan). Same in-process TTL pattern as lib/refs.py.
_SPEND_CACHE: dict[str, tuple[float, float, float]] = {}  # brand -> (ts, spend, budget)
_TTL_SECONDS = 60


def record(brand_id: str, **counters: int) -> None:
    """Atomically increment one or more counters on today's usage doc."""
    if not counters:
        return
    patch: dict[str, Any] = {k: Increment(int(v)) for k, v in counters.items()}
    patch["updatedAt"] = SERVER_TIMESTAMP
    try:
        fs.usage_doc(brand_id).set(patch, merge=True)
    except Exception as e:
        log.warning(f"usage record failed: {e}")


def estimated_spend_today(brand_id: str) -> float:
    snap = fs.usage_doc(brand_id).get()
    if not snap.exists:
        return 0.0
    data = snap.to_dict() or {}
    total = 0.0
    for key, per_unit in COST_PER_UNIT.items():
        total += float(data.get(key, 0)) * per_unit
    return total


def _spend_and_budget(brand_id: str) -> tuple[float, float]:
    """(spend_today, daily_budget) with a short in-process cache."""
    cached = _SPEND_CACHE.get(brand_id)
    if cached and (time.time() - cached[0] < _TTL_SECONDS):
        return cached[1], cached[2]
    try:
        spend = estimated_spend_today(brand_id)
        brand = fs.brand_doc(brand_id).get()
        bdata = (brand.to_dict() or {}) if brand.exists else {}
        budget = float(bdata.get("dailyBudgetUsd") or DEFAULT_DAILY_BUDGET_USD)
    except Exception as e:
        # Never let a guard failure block the pipeline — fail open, but say so.
        log.warning(f"budget lookup failed, failing open: {e}")
        return 0.0, float("inf")
    _SPEND_CACHE[brand_id] = (time.time(), spend, budget)
    return spend, budget


def degrade_level(brand_id: str) -> int:
    """How hard to throttle right now. See the DEGRADE_* ladder above."""
    spend, budget = _spend_and_budget(brand_id)
    if budget <= 0 or budget == float("inf"):
        return DEGRADE_NORMAL
    pct = spend / budget
    if pct < 0.70:
        return DEGRADE_NORMAL
    if pct < 0.85:
        return DEGRADE_TRIM
    if pct < 0.95:
        return DEGRADE_BRAND_ONLY
    if pct < 1.00:
        return DEGRADE_NO_SCRAPE
    return DEGRADE_CACHE_ONLY


def scraping_allowed(brand_id: str) -> bool:
    """Gate for anything that spends Apify credit. Call this at PUBLISH time —
    refusing to enqueue 25,000 messages is where the saving is, not refusing
    each one on the way out."""
    return degrade_level(brand_id) < DEGRADE_NO_SCRAPE


def remaining_budget_usd(brand_id: str) -> float:
    """Dollars left in today's budget, for SIZING a scan before it commits.

    The degrade ladder answers "how throttled are we NOW"; this answers "how
    much may the scan about to be enqueued cost". Without it the shipped
    defaults projected ~$40 against a $5 budget: the ladder let the scan
    through at level 0 and the whole day's budget was spent in one click,
    because Apify bills at ENQUEUE time and the ladder only reacts to spend
    that already happened. Infinity on the fail-open path, matching
    _spend_and_budget: a broken guard must not block the pipeline.
    """
    spend, budget = _spend_and_budget(brand_id)
    if budget == float("inf") or budget <= 0:
        return float("inf")
    return max(0.0, budget - spend)


def budget_exhausted(brand_id: str) -> bool:
    """True only at the hardest degrade level, where even cache-miss detection
    is refused. Deliberately conservative: work already scraped should finish,
    because the Apify spend for it is already sunk.

    NB this was `return False` unconditionally — no budget was enforced anywhere
    despite the setting existing in the UI. Re-enabling it changes production
    behaviour, so verify against a real usage doc before relying on it.
    """
    return degrade_level(brand_id) >= DEGRADE_CACHE_ONLY


def frame_budget_cap(brand_id: str) -> int | None:
    """Upper bound on video frames under the current degrade level.

    None means "no cap" — let the caller use its duration-derived budget.
    """
    lvl = degrade_level(brand_id)
    if lvl <= DEGRADE_NORMAL:
        return None
    if lvl == DEGRADE_TRIM:
        return 4
    return 3
