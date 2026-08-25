#!/usr/bin/env bash
# Eén volledige verversronde — het script achter de "Opnieuw scrapen"-knop.
#
# De knop op de evenementpagina (dev-dashboard) POST naar de Vite-middleware,
# die dit script detached start met stdout naar .tmp/scrape-<event>.log en een
# lock op .tmp/scrape-<event>.lock. Het recept is de samenvoeging van
# recap_hunt.sh en sweep_stories.sh: alle vier de archieven verversen, alles
# nieuws beoordelen, fixtures herbouwen. Handmatig draaien kan ook gewoon:
#
#   tools/stelz_brand_watch/79_verversronde.sh lowlands-2026
#
# Kosten per ronde: scrapen ≈ $0,45 (stories ~$0,18 + roster-IG ~$0,26;
# TikTok en discovery gratis). De analysekosten hangen af van de oogst —
# Gemini beoordeelt alleen items zonder oordeel (~$0,007 per item): een stille
# week is vrijwel gratis, een druk festivalweekend (~950 nieuwe items) kost
# een paar dollar. Duur: 10 minuten tot een uur, om dezelfde reden.
set -uo pipefail

EVENT="${1:-lowlands-2026}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PY="$ROOT/firebase/functions/venv/bin/python"
[ -x "$PY" ] || { echo "geen venv op $PY"; exit 2; }

# Zonder dit is Python's stdout blok-gebufferd naar het logbestand en komt de
# voortgang van een stap pas bij zijn exit binnen — de statusweergave achter
# de knop leest dit log live.
export PYTHONUNBUFFERED=1

# De middleware schrijft de lock met onze pid; wij ruimen hem op, hoe de ronde
# ook eindigt. Een achtergebleven lock met dode pid wordt door de middleware
# als "vorige ronde gecrasht" gemeld en bij de volgende start opgeruimd.
LOCK="$ROOT/.tmp/scrape-${EVENT}.lock"
trap 'rm -f "$LOCK"' EXIT

# Zeven dagen terug dekt elk gat tussen twee klikken ruim af; alles ouders is
# al gearchiveerd en wordt door de dedupe toch overgeslagen.
SINCE="$(date -v-7d +%F)"

# Nooit stoppen op één gefaalde stap — zelfde regel als de andere runners: een
# gefaalde stap kost niets, want de volgende ronde pakt dezelfde rijen weer op.
step() {
  echo "[$(date +%FT%T)] → $1 ${*:2}"
  "$PY" "$ROOT/tools/stelz_brand_watch/$1" "${@:2}" \
    || echo "[$(date +%FT%T)] $1 faalde — door naar de volgende stap"
}

echo "[$(date +%FT%T)] verversronde start — $EVENT, nieuwe posts sinds $SINCE"
step 62_stories_archive.py --event "$EVENT"
step 70_tiktok_archive.py --event "$EVENT" --per-handle 30
step 71_ig_posts_archive.py --event "$EVENT" --per-handle 4 --since "$SINCE"
# Geen --per-tag/--per-brand-tag: de eventdefinitie geldt. De brede vangnetten
# uit de jachtfase (300 per event-tag) waren daar op hun plaats; als staande
# knop zouden ze het Gemini-plafond naar ~$30 per ronde tillen op tags die
# vrijwel nooit converteren.
step 73_lowlands_discovery.py --event "$EVENT" --since "$SINCE"

# --max-dim 0 verplicht: 74 weigert twee resoluties in één archief te mengen,
# dus een vergeten vlag stopt de run in plaats van stilletjes te verslechteren.
for archief in stories tiktok ig-posts discovery; do
  step 74_analyse.py --event "$EVENT" --archive "$archief" --max-dim 0
done

step 72_campaign_fixture.py --event "$EVENT"
step 76_audience.py --event "$EVENT"
step 61_stories_preview_fixture.py
step 77_voortgang.py --event "$EVENT"

# De statusafleiding in web/scrape-runner.ts herkent een geslaagde ronde aan
# precies deze regel — herformuleren betekent dáár ook aanpassen.
echo "[$(date +%FT%T)] verversronde klaar"
