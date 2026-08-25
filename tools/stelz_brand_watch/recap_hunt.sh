#!/usr/bin/env bash
# De recap-staart van de 100-postsjacht.
#
# WAAROM DIT BESTAAT. Op maandagmiddag 24 aug staat de teller op 79 van 100 en
# is alles wat NU bestaat gescraped: twee opeenvolgende rondes leverden <3
# nieuwe posts. Wat rest is content die nog niet bestaat — de recap-golf.
# Festivalgangers knippen hun vlogs op maandag t/m woensdag, en het
# evenementvenster telt posts t/m 30 aug mee. Dit script haalt die golf op:
#
#   dinsdag  ~09:30  TikTok-discovery (gratis scrape) + analyse
#   woensdag ~09:30  idem + één roster-IG-pas sinds 24 aug (~$0,39)
#
# Kosten per ronde zijn vrijwel alleen Gemini op écht nieuwe items; dedupe
# maakt herhaalde tag-scrapes incrementeel. Stories lopen al via de
# sweep_stories-loop (tot 26 aug). Na woensdag stopt dit vanzelf.
#
#   tools/stelz_brand_watch/recap_hunt.sh
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PY="$ROOT/firebase/functions/venv/bin/python"
[ -x "$PY" ] || { echo "geen venv op $PY"; exit 2; }

# Nooit stoppen op één gefaalde stap — zelfde regel als sweep_stories.sh:
# een gemiste ronde kost content, een gefaalde stap kost niets want de
# volgende ronde pakt dezelfde rijen weer op.
step() {
  "$PY" "$ROOT/tools/stelz_brand_watch/$1" "${@:2}" \
    || echo "[$(date +%FT%T)] $1 faalde — door naar de volgende stap"
}

ronde() {
  echo "[$(date +%FT%T)] recap-ronde start"
  step 73_lowlands_discovery.py --event lowlands-2026 --since 2026-08-17 \
       --per-tag 300 --per-brand-tag 150
  if [ "${1:-}" = "--met-roster-ig" ]; then
    # Eén keer, woensdag: de roster-recaps op Instagram sinds de festivaluitloop.
    step 71_ig_posts_archive.py --event lowlands-2026 --per-handle 6 --since 2026-08-24
    step 74_analyse.py --event lowlands-2026 --archive ig-posts --max-dim 0
  fi
  step 74_analyse.py --event lowlands-2026 --archive discovery --max-dim 0
  step 72_campaign_fixture.py --event lowlands-2026
  step 76_audience.py --event lowlands-2026
  step 77_voortgang.py --event lowlands-2026
}

wacht_tot() {  # wacht_tot JJJJ-MM-DD UU:MM
  local doel; doel=$(date -j -f "%Y-%m-%d %H:%M" "$1 $2" +%s 2>/dev/null) || return 1
  local nu; nu=$(date +%s)
  [ "$doel" -gt "$nu" ] && sleep $(( doel - nu ))
  return 0
}

wacht_tot 2026-08-25 09:30 && ronde
wacht_tot 2026-08-26 09:30 && ronde --met-roster-ig
echo "[$(date +%FT%T)] recap-jacht klaar — zie 77_voortgang hierboven voor de eindstand"
