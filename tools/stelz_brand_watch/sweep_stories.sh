#!/usr/bin/env bash
# Keep sweeping Instagram stories while an event runs.
#
# WHY THIS IS A LOOP AND NOT A ONE-OFF. handlers/scan_stories.STORY_TTL_HOURS is
# 24: a story is gone a day after it is posted and the CDN link behind it dies
# sooner than that. There is no backfill, no archive, no "fetch last week" — an
# hour not swept is an hour that never existed. Day one of Lowlands produced 96
# stories in a single sweep, roughly four per festival hour.
#
# A sweep fetches, judges, and refreshes the dashboard fixtures. Apify costs
# about $0.18 ($0.099 per run + $0.003 per handle); the Gemini pass costs about
# $0.0044 per new story, so a busy three-hour window is roughly $0.20 all in.
# Every step is idempotent: stories already archived are skipped by id, an image
# that downloaded once is never re-fetched, and a story already judged is never
# re-billed. Running it too often wastes money; running it every three hours
# cannot miss a story, because nothing expires faster than 24h.
#
#   tools/stelz_brand_watch/sweep_stories.sh lowlands-2026 2026-08-24
#
# The second argument is the last day to sweep, inclusive — normally the day
# after the event ends, so the final evening's stories are caught before they
# expire. The loop exits by itself after that.
#
# To run it unattended, put it in crontab instead (every three hours):
#   0 */3 * * * cd "/path/to/Stelz tool" && tools/stelz_brand_watch/sweep_stories.sh lowlands-2026 2026-08-24 >> /tmp/stelz-sweep.log 2>&1
# In crontab the loop is pointless — pass ONCE=1 to do a single sweep and exit:
#   0 */3 * * * ... ONCE=1 tools/stelz_brand_watch/sweep_stories.sh lowlands-2026 2026-08-24
set -uo pipefail

EVENT="${1:-lowlands-2026}"
UNTIL="${2:?geef een einddatum: JJJJ-MM-DD}"
EVERY="${EVERY:-10800}"          # 3 hours
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PY="$ROOT/firebase/functions/venv/bin/python"

[ -x "$PY" ] || { echo "geen venv op $PY"; exit 2; }

# Never abort the loop on a failed step. Apify times out, the network drops, a
# token expires, the model returns nothing — and the next window is still worth
# trying, because the alternative is silently stopping and losing every hour
# after the failure. A missed sweep costs stories that never come back; a failed
# analysis costs nothing, because the next sweep picks the same rows back up.
step() {
  "$PY" "$ROOT/tools/stelz_brand_watch/$1" "${@:2}" \
    || echo "[$(date +%FT%T)] $1 faalde — door naar de volgende stap"
}

while :; do
  today="$(date +%F)"
  if [[ "$today" > "$UNTIL" ]]; then
    echo "[$(date +%FT%T)] $today ligt na $UNTIL — klaar."
    exit 0
  fi
  echo "[$(date +%FT%T)] sweep $EVENT"
  step 62_stories_archive.py --event "$EVENT"
  # Archiving without judging is what this loop used to do, and it produced 184
  # stories from the three busiest festival days that the dashboard could not
  # show: a Stëlz-only grid filters on a verdict, and an unjudged story has
  # none. So the sweep judges what it just fetched, in the same pass.
  #
  # --max-dim 0 is hard-coded on purpose. The flag's default is 512 (production
  # resolution) and 74_analyse REFUSES to mix two resolutions in one archive —
  # so a forgotten flag here does not quietly halve what the model can see, it
  # stops the run. Hard-coding it means the question never comes up at 3am.
  step 74_analyse.py --event "$EVENT" --archive stories --max-dim 0
  # And put it on screen. Both fixtures are local dev files read by the Vite
  # serve-only middleware; neither is ever built or deployed.
  step 72_campaign_fixture.py --event "$EVENT"
  step 61_stories_preview_fixture.py

  [ -n "${ONCE:-}" ] && exit 0
  sleep "$EVERY"
done
