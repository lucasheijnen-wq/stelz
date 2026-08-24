#!/usr/bin/env python3
"""De teller van de jacht: unieke in-venster posts met Stëlz, plus de sneeuwbal.

WAAROM DIT EEN TOOL IS EN GEEN LOSSE REGEL PYTHON. Het getal "hoeveel posts
hebben we" is drie keer in één gesprek inline uitgerekend, elke keer nét
anders (waarnemingen vs posts, wel of geen vensterfilter, carrouseldia's als
één of als drie). Het doel is 100 en een doel verdient één teller die elke
ronde exact hetzelfde rekent:

    post       = (handle, short_code | video_id)  — een carrousel is één post
    in venster = E.in_window over posted_at        — zelfde regel als het dashboard
    treffer    = detected == true in verdicts.jsonl

DE SNEEUWBAL is de tweede uitvoer: non-roster accounts met een treffer waarvan
we vrijwel niets in het archief hebben. Wie het blikje één keer filmde heeft er
vrijwel zeker meer, en TikTok-profielen scrapen is gratis — dus elke ronde
voedt de volgende. De lijst print als een kant-en-klare --handles regel.

    tools/stelz_brand_watch/77_voortgang.py --event lowlands-2026

Leest alleen. Kost niets. Draai na elke 74-analyse.
"""

from __future__ import annotations

import argparse
import collections
import importlib.util
import json
from pathlib import Path

_espec = importlib.util.spec_from_file_location(
    "_events", Path(__file__).with_name("_events.py"))
E = importlib.util.module_from_spec(_espec)
_espec.loader.exec_module(E)

DOEL = 100

# Onder dit aantal archiefitems geldt een treffer-account als "nog niet
# gescraped": een hashtagvondst levert 1-3 items, een profielscrape ~20.
SCRAPE_DREMPEL = 8


def read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(l) for l in path.read_text(encoding="utf-8").splitlines() if l.strip()]


def verdicts_by_id(rows: list[dict]) -> dict[str, dict]:
    out = {}
    for d in rows:
        k = d.get("item_id") or d.get("story_id") or d.get("post_id")
        if k is not None:
            out[str(k)] = d
    return out


def item_id(item: dict) -> str:
    return str(item.get("video_id") or item.get("item_id") or item.get("story_id") or "")


def post_key(item: dict) -> tuple[str, str]:
    """One key per POST: carousel slides share their short_code and collapse."""
    return ((item.get("handle") or "").lower(),
            str(item.get("short_code") or item.get("video_id") or item_id(item)))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--event", default="lowlands-2026", choices=E.available())
    args = ap.parse_args()
    ev = E.load(args.event)
    roster = {h.lower() for h in E.roster_accounts(ev)}

    grand: set[tuple[str, str]] = set()
    per_handle_items: collections.Counter = collections.Counter()
    hit_handles: collections.Counter = collections.Counter()

    print(f"\n  {ev['name']} — voortgang naar {DOEL} posts met Stëlz\n")
    print(f"  {'archief':<10} {'items':>6} {'beoordeeld':>10} {'posts met Stëlz':>16}")
    for kind in E.KINDS:
        base = E.archive_dir(ev, kind)
        items = read_jsonl(base / "index.jsonl")
        verd = verdicts_by_id(read_jsonl(base / "verdicts.jsonl"))
        posts: set[tuple[str, str]] = set()
        for item in items:
            h = (item.get("handle") or "").lower()
            per_handle_items[h] += 1
            d = verd.get(item_id(item))
            if not d or not d.get("detected"):
                continue
            ts = item.get("posted_at") or item.get("taken_at")
            if not E.in_window(ev, ts):
                continue
            key = post_key(item)
            posts.add(key)
            grand.add(key)
            if h and h not in roster:
                hit_handles[h] += 1
        print(f"  {kind:<10} {len(items):>6} {len(verd):>10} {len(posts):>16}")

    n = len(grand)
    print(f"\n  TOTAAL: {n} unieke posts · doel {DOEL} · "
          + (f"nog {DOEL - n} te gaan" if n < DOEL else "DOEL BEREIKT"))

    # De sneeuwbal: treffer-accounts die nog geen profielscrape kregen.
    snowball = sorted(
        (h for h in hit_handles if per_handle_items[h] < SCRAPE_DREMPEL),
        key=lambda h: (-hit_handles[h], h))
    if snowball:
        print(f"\n  Sneeuwbal — {len(snowball)} treffer-accounts met <{SCRAPE_DREMPEL} "
              f"archiefitems (profiel nog niet gescraped):")
        for h in snowball:
            print(f"    {hit_handles[h]}× @{h}  ({per_handle_items[h]} items in archief)")
        print("\n  Kant-en-klaar voor ronde n+1:")
        print("    --handles " + " ".join(snowball))
    else:
        print("\n  Sneeuwbal leeg: elk treffer-account is al doorgescraped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
