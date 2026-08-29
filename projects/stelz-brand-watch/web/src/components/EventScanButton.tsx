// The "Online scan" button — the one that exists in production.
//
// WHY THERE ARE TWO SCRAPE BUTTONS ON AN EVENT PAGE, and why they are not the
// same button. They drive two different pipelines:
//
//   Opnieuw scrapen  Local. Runs 79_verversronde.sh on this machine: the Python
//                    harvesters, the archives in .tmp/, full-resolution
//                    analysis, and an upload at the end. It exists only under
//                    `vite dev` because nothing behind it exists anywhere else,
//                    which is why the deployed dashboard has never had it.
//   Online scan      This one. Calls the member-gated Cloud Functions that the
//                    schedulers call — scan_stories and scan_creators — so it
//                    works from the deployed dashboard, from any machine, with
//                    no Python and no laptop involved.
//
// SCOPED TO THIS EVENT'S ROSTER, which is the whole reason this is not just the
// Home page's "Run scan" moved here. scan_creators picks creators off a due
// queue (nextScanAt <= now), and a project roster runs on a 12-hour cadence: a
// second press inside that window found nobody due and reported a successful
// scan of zero accounts. Passing the roster's creatorIds bypasses the queue, so
// the button scans the people it was pressed for. scan_stories has the mirror
// problem — a tier query with a limit and no ordering — and takes the same list.
//
// HASHTAG DISCOVERY IS NOT IN THE DEFAULT, on purpose. The cloud discovery step
// fans out over the BRAND's hashtag pool, not this event's tags; publish_tags
// has no per-event scoping, and at the UI defaults one click can enqueue
// ~25,000 Apify results. An event button that quietly did that would be a cost
// trap, so it is a checkbox that says what it is.

import { useState } from 'react'
import { Button } from './ui'
import {
  fbScanSession, fbStepCreators, fbStepHashtags, fbStepStories, type ScanState,
} from '../lib/firestore'
import { scanIsStale } from '../lib/scanProgress'
// ONE APIFY BATCH PER REQUEST, and why — see lib/scanChunks. In short:
// api_step_creators has 540 seconds and one Apify batch can take 210, so a
// roster sent whole was a killed container rather than a slow scan.
import { chunksOf, remainderOf } from '../lib/scanChunks'
import { useNow } from '../lib/useNow'
import type { Project } from '../lib/data'

const POSTS_PER = 8
/** Server says `more_remaining` when its own deadline cut a call short. We
 *  repeat that chunk, but never forever: a runaway loop here spends real Apify
 *  money on every pass. */
const MAX_RETRIES_PER_CHUNK = 3

/** Why a scan did nothing, in words. The server names the cause in `skipped`;
 *  reporting all of them as "the backend is out of date" is the exact
 *  misdiagnosis this component was last edited to stop. */
function skipReason(skipped: string): string {
  if (skipped === 'budget_exhausted') return 'Het dagbudget is op — deze scan is niet uitgevoerd.'
  if (skipped === 'budget') return 'Het dagbudget is bijna op, dus scrapen staat uit. Deze scan is niet uitgevoerd.'
  if (skipped === 'no_creators') {
    return 'Geen van deze roster-profielen wordt nog gevolgd. Importeer de roster '
      + 'opnieuw bij Instellingen.'
  }
  return `Scan overgeslagen: ${skipped}.`
}

export function EventScanButton({ scan, project, canWrite, loading, eventTags = [] }: {
  scan: ScanState | null
  project: Project | null
  canWrite: boolean
  /** This event's own hashtags. Passing them scrapes THIS festival; leaving
   *  them empty falls back to the brand pool, which for an event page means
   *  scanning #vrijmibo and never #lowlands. See publish_tags. */
  eventTags?: string[]
  /** Projects are still being fetched. Nothing is known yet, so nothing is
   *  said: `project` is null both while loading and when there genuinely is
   *  none, and rendering "roster nog niet geïmporteerd" over the first case
   *  flashes a false statement at every visitor of an event that HAS one. */
  loading: boolean
}) {
  const [clicking, setClicking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [withTags, setWithTags] = useState(false)
  const now = useNow(15_000)

  const running = !!scan?.startedAt && !scan.finishedAt && !scanIsStale(scan, now)
  const busy = clicking || running
  const roster = project?.creatorIds ?? []

  // An aborted POST is not a failed scan: the function keeps running server-
  // side after the connection drops, and the scan-state stream is the truth.
  // When that stream says a scan is underway, a lingering fetch error would be
  // contradicting it on the same screen — clear it. During render, same
  // pattern as ScanPanel's phase transition, so no flash of both.
  const [lastRunning, setLastRunning] = useState(false)
  if (running !== lastRunning) {
    setLastRunning(running)
    if (running && error) setError(null)
  }

  if (loading) return null

  // Nothing to scan and nothing to explain away: the roster lives in a project
  // document, and without one there are no creator docs for the cloud functions
  // to read. Settings → Roster is where that gets fixed, so say so rather than
  // offering a button that would report "no_creators" a minute later.
  if (!project || roster.length === 0) {
    return (
      <span className="text-[10px] text-right text-[var(--color-ink-subtle)] max-w-[220px]">
        Roster nog niet geïmporteerd — dat kan bij <strong>Instellingen</strong>.
        Daarna kan deze pagina online gescand worden.
      </span>
    )
  }

  if (!canWrite) {
    return (
      <span className="text-[10px] text-right text-[var(--color-ink-subtle)] max-w-[220px]">
        Scannen vereist schrijfrechten.
      </span>
    )
  }

  const go = async () => {
    setClicking(true)
    setError(null)
    setProgress(null)
    // Collected, not set as we go: every step used to write straight to
    // `error`, so the last one to speak erased what the others had found —
    // ticking "ook hashtags" was enough to wipe a roster-scoping warning off
    // the screen before anyone read it.
    const notes: string[] = []
    // Only close what we opened. With hashtags the fan-out opens its own
    // session and its LAST tag worker closes it; closing it here would mark a
    // scan finished while its workers were still scraping.
    let weOpenedSession = false
    try {
      if (withTags) {
        // The event's own tags when we have them. The brand pool has no
        // #lowlands in it and never should — a festival tag scraped forever
        // after the festival is pure cost — so an event scrape has to carry
        // its list rather than rely on the pool.
        //
        // This also opens the scan session for us: publish_tags writes the
        // flat scan.startedAt and its LAST tag worker closes it, so we must
        // not open or close one ourselves — marking the session finished here
        // would call a scan done while its workers were still scraping.
        await fbStepHashtags(150, 30, eventTags.map((t) => ({ tag: t })))
          .catch((e) => { notes.push(`Hashtags: ${(e as Error).message}`) })
      } else {
        await fbScanSession('open').catch(() => { /* progress only, never fatal */ })
        weOpenedSession = true
      }

      // Stories unawaited: they expire after 24 hours, so they must never
      // queue behind a creator scrape that runs for minutes. Sized to the
      // roster — the old ROSTER_CAP of 200 made the one stories call scrape
      // every tier_1/tier_2 account in the brand on a backend that ignores
      // creatorIds, at several times the intended cost.
      void fbStepStories(roster.length, roster)
        .catch((e) => setError(`Stories: ${(e as Error).message}`))

      let scopeChecked = false
      let done = 0
      for (const piece of chunksOf(roster)) {
        let chunk: string[] = piece
        for (let attempt = 0; attempt < MAX_RETRIES_PER_CHUNK && chunk.length > 0; attempt++) {
          const out = await fbStepCreators(chunk.length, POSTS_PER, chunk) as {
            scope?: string; skipped?: string; more_remaining?: number
          }
          // THE SILENT WRONG SCAN, checked once. A backend that predates
          // creatorIds ignores the field without a word and scans the
          // brand-wide due queue instead of this roster. `scope` now rides on
          // every return including the skipped ones, so its absence really
          // does mean an old build — it no longer fires at a correctly
          // deployed backend that merely refused for budget.
          if (!scopeChecked) {
            scopeChecked = true
            if (out.scope !== 'named') {
              notes.push('De online pijplijn draait nog een oude versie zonder '
                + 'roster-scoping — deze scan liep merkbreed, niet over deze '
                + 'roster. Vraag om een functions-deploy.')
            }
          }
          // A refusal applies to the whole run, not just this chunk: the
          // budget gates are brand-wide. Stop rather than pay for the rest.
          if (out.skipped) {
            notes.push(skipReason(out.skipped))
            setProgress(null)
            setError(notes.join(' '))
            return
          }
          // The server ran out of its own deadline mid-chunk and says how many
          // handles it never started. Repeat only that tail — resending the
          // whole chunk would pay Apify twice for the ones that succeeded.
          const rest = remainderOf(chunk, out.more_remaining)
          done += chunk.length - rest.length
          setProgress(`${done} van ${roster.length} profielen`)
          chunk = rest
        }
      }
      setProgress(null)
    } catch (e) {
      notes.push((e as Error).message)
    } finally {
      if (weOpenedSession) {
        await fbScanSession('close').catch(() => { /* the stall detector covers it */ })
      }
      setClicking(false)
      if (notes.length > 0) setError(notes.join(' '))
    }
  }

  return (
    <span className="inline-flex flex-col items-end gap-1 max-w-[300px]">
      <Button
        size="sm"
        variant="primary"
        disabled={busy}
        onClick={() => { void go() }}
        title={`Scant de ${roster.length} profielen van deze roster via de online `
          + 'pijplijn: Instagram-stories en de feeds van beide platforms, daarna '
          + 'de beeldanalyse. Werkt vanaf elke computer — hier draait geen '
          + 'Python. Kost Apify- en Gemini-tegoed.'}
      >
        {clicking ? 'Starten…' : running ? 'Scan loopt…' : 'Online scan'}
      </Button>
      <label className="flex items-center gap-1.5 text-[10px] text-[var(--color-ink-subtle)] cursor-pointer">
        <input
          type="checkbox"
          checked={withTags}
          onChange={(e) => setWithTags(e.target.checked)}
          disabled={busy}
        />
        {/* Named for what it actually does. "Ook discovery" would read as "also
            this event's tags", and it is not — it is the brand's whole pool. */}
        ook hashtags scannen (merkbreed, duurder)
      </label>
      <span className={`text-[10px] text-right ${
        error ? 'text-[var(--color-bad)]' : 'text-[var(--color-ink-subtle)]'}`}>
        {/* Progress beats the idle line but never an error: a scan that went
            wrong must not be narrated as if it were still going well. */}
        {error ?? progress ?? `${roster.length} profielen · voortgang hieronder`}
      </span>
    </span>
  )
}
