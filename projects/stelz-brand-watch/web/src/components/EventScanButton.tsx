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
import { fbStepCreators, fbStepHashtags, fbStepStories, type ScanState } from '../lib/firestore'
import { scanIsStale } from '../lib/scanProgress'
import { useNow } from '../lib/useNow'
import type { Project } from '../lib/data'

/** Instagram stories + both feed surfaces for a roster this size need headroom
 *  over the brand-wide defaults: 28 people is 56 creator docs across two
 *  platforms, and the default cap of 80 is shared with everyone else tracked. */
const ROSTER_CAP = 200
const POSTS_PER = 8

export function EventScanButton({ scan, project, canWrite, loading }: {
  scan: ScanState | null
  project: Project | null
  canWrite: boolean
  /** Projects are still being fetched. Nothing is known yet, so nothing is
   *  said: `project` is null both while loading and when there genuinely is
   *  none, and rendering "roster nog niet geïmporteerd" over the first case
   *  flashes a false statement at every visitor of an event that HAS one. */
  loading: boolean
}) {
  const [clicking, setClicking] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [withTags, setWithTags] = useState(false)
  const now = useNow(15_000)

  const running = !!scan?.startedAt && !scan.finishedAt && !scanIsStale(scan, now)
  const busy = clicking || running
  const roster = project?.creatorIds ?? []

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
    try {
      // Stories first and unawaited: they expire after 24 hours, so they must
      // never queue behind a creator scrape that can run for minutes.
      void fbStepStories(ROSTER_CAP, roster)
        .catch((e) => setError(`Stories: ${(e as Error).message}`))
      await fbStepCreators(ROSTER_CAP, POSTS_PER, roster)
      if (withTags) {
        await fbStepHashtags()
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setClicking(false)
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
        {error ?? `${roster.length} profielen · voortgang hieronder`}
      </span>
    </span>
  )
}
