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
    en telbaar = het dashboard zou hem tonen: roster, óf een eigen matchende
                 tag (caption of vastgelegde zoektag), óf accountbewijs — een
                 ándere in-venster post van hetzelfde account mét zo'n tag.
                 Zonder die laatste regel telde deze teller één post meer dan
                 het dashboard: een Stëlz-vondst op het profiel van een getagde
                 vriend die zelf nooit een Lowlands-tag gebruikte. Materieel
                 waarschijnlijk wél Lowlands, maar niet verantwoordbaar — en
                 een teller die meer telt dan het scherm is precies de
                 "verruimde definitie" die het plan uitsluit.

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


def matching_tags(ev: dict, item: dict) -> bool:
    """Draagt dit item zelf bewijs — een caption-tag of vastgelegde zoektag
    uit de taglijst van het evenement?"""
    ordered = {t for t, _ in E.tags(ev)}
    via = (item.get("found_via") or "").lstrip("#").lower()
    if via and via in ordered:
        return True
    return any(t.lstrip("#").lower() in ordered for t in (item.get("hashtags") or []))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--event", default="lowlands-2026", choices=E.available())
    args = ap.parse_args()
    ev = E.load(args.event)
    roster = {h.lower() for h in E.roster_accounts(ev)}

    # PAS 1: bewijs verzamelen — welke non-roster accounts hebben ergens in het
    # venster een item mét matchende tag? Zelfde regel als
    # events.evidencedHandlesFor aan de dashboardkant.
    all_items: dict[str, list[dict]] = {}
    evidenced: set[str] = set()
    for kind in E.KINDS:
        base = E.archive_dir(ev, kind)
        all_items[kind] = read_jsonl(base / "index.jsonl")
        for item in all_items[kind]:
            h = (item.get("handle") or "").lower()
            if not h or h in roster or h in evidenced:
                continue
            ts = item.get("posted_at") or item.get("taken_at")
            if E.in_window(ev, ts) and matching_tags(ev, item):
                evidenced.add(h)

    grand: set[tuple[str, str]] = set()
    per_handle_items: collections.Counter = collections.Counter()
    hit_handles: collections.Counter = collections.Counter()
    orphan_hits = 0

    print(f"\n  {ev['name']} — voortgang naar {DOEL} posts met Stëlz\n")
    print(f"  {'archief':<10} {'items':>6} {'beoordeeld':>10} {'posts met Stëlz':>16}")
    for kind in E.KINDS:
        base = E.archive_dir(ev, kind)
        items = all_items[kind]
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
            # PAS 2: telbaar zoals het dashboard telt — roster, eigen tag, of
            # accountbewijs. Een wees (geen van drieën) telt niet mee, hoe
            # echt zijn blikje ook is.
            if h not in roster and not matching_tags(ev, item) and h not in evidenced:
                orphan_hits += 1
                continue
            key = post_key(item)
            posts.add(key)
            grand.add(key)
            if h and h not in roster:
                hit_handles[h] += 1
        print(f"  {kind:<10} {len(items):>6} {len(verd):>10} {len(posts):>16}")
    if orphan_hits:
        print(f"\n  ({orphan_hits} treffer-waarneming(en) niet geteld: wees — geen tag, "
              f"geen accountbewijs, dus ook niet op het dashboard)")

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
