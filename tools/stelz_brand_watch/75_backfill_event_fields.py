#!/usr/bin/env python3
"""Add fields to archive rows harvested before those fields existed.

    ./firebase/functions/venv/bin/python \\
        tools/stelz_brand_watch/75_backfill_event_fields.py --event lowlands-2026
        ... --dry-run

Free. Reads only what is already on disk — no Apify, no Gemini.

WHY scraped_for MATTERS. Instagram publishes a collab post on both authors'
profiles. Apify returns it under whichever profile the run asked for, and
records that request as `inputUrl` on the raw payload. Without it, 44 archived
rows across 15 accounts — @golfnl, agencies, brand accounts — read as strangers
who happened to post about the festival, when in fact they are roster
deliveries with a co-author. Counted as organic pickup they would credit the
campaign with reach it paid for, which is the flattering direction and
therefore the one worth a script.

WHY STORY STATS MATTER. 62 wrote eight fields per story and left everything
else in the raw payload, so the campaign page's story column was permanently
blank while the stories page — reading the same payloads — showed 86,718 poll
votes. A story publishes no view count at all (Instagram shows that to the
account holder and nobody else); poll votes are the only hard figure it
produces, and they are a floor on viewers rather than a reach number.

The raw payloads were kept verbatim for exactly this reason: a field the
harvester did not extract at the time can still be recovered from them, and the
archive does not have to be re-scraped to gain a column. Stories cannot be
re-scraped at all — they are gone after 24 hours.

Idempotent. A row that already has both fields is left alone, and the pass can
be re-run after any harvest.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "firebase" / "functions"))
# The same normaliser 62 and 61 use, so the three cannot form three opinions
# about what a story's poll count is.
from handlers.scan_stories import _normalize_item  # noqa: E402
_espec = importlib.util.spec_from_file_location(
    "_events", Path(__file__).with_name("_events.py"))
E = importlib.util.module_from_spec(_espec)
_espec.loader.exec_module(E)


def profile_from(url: str | None) -> str | None:
    m = re.search(r"instagram\.com/([^/?#]+)", str(url or ""))
    if not m:
        return None
    handle = m.group(1).strip().lower()
    # /p/, /reel/ and /stories/ are post URLs, not profile URLs. Reading one as
    # a handle would invent a creator called "p".
    return None if handle in ("p", "reel", "reels", "stories", "explore") else handle


def story_stats(raw: Path) -> dict | None:
    """A story's own numbers, recovered from the payload 62 kept.

    Returns None when the payload is missing or unreadable — better an
    unchanged row than one carrying zeros that were never measured.
    """
    if not raw.exists():
        return None
    try:
        norm = _normalize_item(json.loads(raw.read_text()))
    except Exception:
        return None
    if not norm:
        return None
    return {
        "poll_votes": norm.get("poll_votes") or 0,
        "poll_count": norm.get("poll_count") or 0,
        "poll_questions": norm.get("poll_questions") or [],
        "hashtags": norm.get("hashtags") or [],
        "mentions": norm.get("mentions") or [],
        "music": norm.get("music"),
        "is_paid_partnership": bool(norm.get("is_paid_partnership")),
        "full_name": norm.get("full_name"),
        "verified": norm.get("is_verified"),
        "duration": norm.get("video_duration"),
        "link_urls": norm.get("link_urls") or [],
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--event", default="lowlands-2026", choices=E.available())
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    ev = E.load(args.event)
    roster = E.roster_accounts(ev)
    total_changed = 0

    for kind in E.KINDS:
        P = E.paths(ev, kind)
        if not P.index.exists():
            print(f"  {kind:<10} geen archief")
            continue

        rows = [json.loads(l) for l in P.index.read_text().splitlines() if l.strip()]
        changed = resolved = unresolved = collab = 0
        for row in rows:
            dirty = False
            if row.get("event") != ev["id"]:
                row["event"] = ev["id"]
                dirty = True

            if kind == "stories":
                if "poll_votes" not in row:
                    stats = story_stats(P.raw / (row.get("raw_file") or ""))
                    if stats:
                        row.update(stats)
                        dirty = True
                        resolved += 1
                    else:
                        unresolved += 1
                changed += dirty
                continue

            # Only Instagram feed posts carry a co-author. A TikTok has no such
            # concept, and a story is always the profile's own.
            if kind != "ig-posts" or row.get("scraped_for"):
                changed += dirty
                continue
            raw = P.raw / (row.get("raw_file") or "")
            payload = None
            if raw.exists():
                try:
                    payload = json.loads(raw.read_text())
                except Exception:
                    payload = None
            who = profile_from((payload or {}).get("inputUrl"))
            if not who:
                unresolved += 1
                changed += dirty
                continue
            row["scraped_for"] = who
            row["coauthors"] = [c.get("username") for c in
                                (payload.get("coauthorProducers") or [])
                                if isinstance(c, dict) and c.get("username")]
            changed += 1
            resolved += 1
            if (row.get("handle") or "").lower() not in roster and who in roster:
                collab += 1

        note = f"{changed} rijen bijgewerkt"
        if kind == "stories":
            note += f" · {resolved} met cijfers uit de ruwe payload"
            if unresolved:
                note += f" · {unresolved} zonder bruikbare payload"
        if kind == "ig-posts":
            note += (f" · {resolved} met scraped_for, waarvan {collab} collab "
                     f"(niet-roster account, roster-profiel)")
            if unresolved:
                note += f" · {unresolved} niet te herleiden"
        print(f"  {kind:<10} {note}")

        if changed and not args.dry_run:
            tmp = P.index.with_suffix(".jsonl.tmp")
            tmp.write_text("".join(json.dumps(r) + "\n" for r in rows))
            tmp.replace(P.index)
        total_changed += changed

    print(f"\n{total_changed} rijen "
          f"{'zouden worden bijgewerkt' if args.dry_run else 'bijgewerkt'}")
    if args.dry_run:
        print("--dry-run: niets geschreven.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
