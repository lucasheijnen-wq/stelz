// Scan progress, derived — pure so it can be tested without a browser.
//
// A scan runs seven steps and then spends most of its wall-clock time in a
// detect fan-out that is not a step at all. The old UI showed one 16x2 pixel
// bar for the first step only; the other five ran fire-and-forget and a failure
// in any of them vanished silently.
//
// Everything here degrades: a backend that has not deployed the steps map yet
// yields the same shape from the flat counters, so the panel is never blank.

import type { ScanState, ScanStepKey } from './firestore'

export type StepState = 'pending' | 'running' | 'done' | 'error' | 'skipped'
export type ScanPhase = 'idle' | 'scraping' | 'analysing' | 'done' | 'stalled' | 'error'

/** The derived pseudo-step: where nearly all the time actually goes. */
export const ANALYSIS_KEY = 'analysis' as const
export type StepId = ScanStepKey | typeof ANALYSIS_KEY

export type StepView = {
  key: StepId
  label: string
  state: StepState
  detail: string | null
  error: string | null
}

/** Display order. Analysis sits after the two scrape steps that feed it. */
export const STEP_ORDER: { key: StepId; label: string }[] = [
  { key: 'hashtags', label: 'Hashtags scrapen' },
  { key: 'stories', label: 'Stories ophalen' },
  { key: 'creators', label: 'Creators scrapen' },
  { key: ANALYSIS_KEY, label: 'Beelden analyseren' },
  { key: 'profiles', label: 'Profielen verversen' },
  { key: 'subcultures', label: 'Scenes indelen' },
  // Before SRS in display as in execution: the edges this writes are the
  // graph layer SRS reads.
  { key: 'audience', label: 'Publiek uitbreiden' },
  { key: 'srs', label: 'Resonantie berekenen' },
  { key: 'sentiment', label: 'Sentiment scoren' },
]

/** No worker has written for this long → treat the session as dead. */
export const STALL_MS = 5 * 60_000

/**
 * The outer limit of any believable detect fan-out.
 *
 * The heartbeat freezes during the detect phase (workers bump the counters,
 * not lastActivityAt), so staleness alone cannot tell a draining fan-out from
 * a dead one — which is why `analysing` overrides the stall check. Without a
 * time limit that override is forever: a fan-out that died at 40/100 kept the
 * home page on "Beelden analyseren" for WEEKS, which reads as a scrape that is
 * both running and broken. No real fan-out lives anywhere near this long, so
 * past it, frozen counters mean dead workers, not slow ones.
 */
export const ANALYSIS_ABANDON_MS = 6 * 3600_000

/** Too few completions to extrapolate from; an ETA here swings wildly. */
const ETA_MIN_SAMPLES = 20

/** The most recent thing the backend ever wrote about this scan. */
function lastSignalMs(s: ScanState): number {
  return Math.max(
    s.startedAt ? new Date(s.startedAt).getTime() : 0,
    s.finishedAt ? new Date(s.finishedAt).getTime() : 0,
    s.lastActivityAt ? new Date(s.lastActivityAt).getTime() : 0,
  )
}

/** Incomplete counters past any believable fan-out lifetime. */
function analysisAbandoned(s: ScanState, now: number): boolean {
  return now - lastSignalMs(s) > ANALYSIS_ABANDON_MS
}

export function analysisProgress(s: ScanState | null, now = Date.now()):
  { done: number; total: number; pct: number; etaMs: number | null } | null {
  if (!s) return null
  const total = s.detectTasksEnqueued ?? 0
  if (total <= 0) return null
  const done = Math.min(s.detectionsCompleted ?? 0, total)
  const pct = Math.round((done / total) * 100)
  let etaMs: number | null = null
  if (done >= ETA_MIN_SAMPLES && done < total && s.startedAt) {
    const elapsed = now - new Date(s.startedAt).getTime()
    if (elapsed > 0) etaMs = Math.round((elapsed / done) * (total - done))
  }
  return { done, total, pct, etaMs }
}

/**
 * An UNFINISHED scan nothing has written to for five minutes.
 *
 * Falls back to startedAt when lastActivityAt never landed: a session that
 * crashed before its first heartbeat used to fail the `last > 0` guard here
 * and read as 'scraping' forever — a pulsing dot over a scan that died at
 * birth. Exported because RunScanButton needs the same judgement and had
 * grown its own copy, which disagreed with this one in exactly that case.
 */
export function scanIsStale(s: ScanState | null, now = Date.now()): boolean {
  if (!s?.startedAt || s.finishedAt) return false
  const last = s.lastActivityAt
    ? new Date(s.lastActivityAt).getTime()
    : new Date(s.startedAt).getTime()
  return now - last > STALL_MS
}

export function scanPhase(s: ScanState | null, now = Date.now()): ScanPhase {
  if (!s || !s.startedAt) return 'idle'
  const steps = s.steps ?? {}
  // A step map entry can say "running" forever: for four commits the backend's
  // hashtags step crashed on close (missing import) AFTER finishedAt was
  // stamped, so scanIsStale never fired and this function read 'scraping' for
  // weeks. "Running" is only believed while the backend has signalled at all
  // recently — same horizon as the analysis pseudo-step, because a healthy
  // creators step legally writes nothing for its full 540s timeout and the
  // 5-minute STALL_MS would call it dead mid-flight.
  const abandoned = s ? analysisAbandoned(s, now) : false
  const hasRunning = Object.values(steps).some((st) => st?.state === 'running')
  const anyRunning = hasRunning && !abandoned
  const anyError = Object.values(steps).some((st) => st?.state === 'error')
  const analysis = analysisProgress(s, now)
  // Incomplete counters read as "analysing" only while the fan-out could
  // still believably be alive — see ANALYSIS_ABANDON_MS.
  const analysing = analysis != null && analysis.done < analysis.total
    && !abandoned

  if (scanIsStale(s, now) && !analysing) return 'stalled'
  if (anyRunning) return 'scraping'
  if (analysing) return 'analysing'
  // An error only becomes the headline once nothing is still running — a failed
  // enrichment step must not hide the fact that detection is still working.
  // Work that died mid-way counts as an error too — a fan-out frozen short of
  // its total, or a step still marked running hours after the last signal —
  // because a green "Scan afgerond" above a dead row would contradict it.
  const analysisDied = analysis != null && analysis.done < analysis.total
    && abandoned
  const runningDied = hasRunning && abandoned
  if (anyError || analysisDied || runningDied) return 'error'
  // Without a steps map, fall back to the flat pair the old pill used.
  if (!s.finishedAt) return 'scraping'
  return 'done'
}

export function stepViews(
  s: ScanState | null,
  clientErrors: Partial<Record<ScanStepKey, string>> = {},
  now = Date.now(),
): StepView[] {
  const steps = s?.steps ?? {}
  const analysis = analysisProgress(s, now)
  const scanFinished = Boolean(s?.finishedAt)

  return STEP_ORDER.map(({ key, label }) => {
    if (key === ANALYSIS_KEY) {
      if (!analysis) {
        return { key, label, state: (scanFinished ? 'skipped' : 'pending') as StepState, detail: null, error: null }
      }
      const incomplete = analysis.done < analysis.total
      // Frozen mid-way past any believable fan-out lifetime: the workers died.
      // Saying so beats a progress bar that promises the rest is still coming.
      if (incomplete && s && analysisAbandoned(s, now)) {
        return {
          key,
          label,
          state: 'error' as StepState,
          detail: `${analysis.done} van ${analysis.total}`,
          error: 'niet afgemaakt — de analyse-workers schrijven al uren niets meer',
        }
      }
      return {
        key,
        label,
        state: (incomplete ? 'running' : 'done') as StepState,
        detail: incomplete
          ? `${analysis.done} van ${analysis.total}${analysis.etaMs != null ? ` · nog ~${Math.max(1, Math.round(analysis.etaMs / 60_000))} min` : ''}`
          : `${analysis.total} beelden · ${s?.detectionsHit ?? 0} hits`,
        error: null,
      }
    }

    const step = steps[key as ScanStepKey]
    const clientError = clientErrors[key as ScanStepKey] ?? null
    if (!step) {
      // No entry: either it has not started yet, or the scan is over and it
      // never ran. Both are worth showing — a step that silently never ran is
      // exactly what used to be invisible.
      return {
        key,
        label,
        state: (scanFinished ? 'skipped' : 'pending') as StepState,
        detail: null,
        error: clientError,
      }
    }
    // "Running" hours after the backend last wrote anything is a step whose
    // close was lost (crash, timeout kill, the four-commit missing-import bug).
    // Saying so beats a pulsing dot that promises the step is still going.
    if (step.state === 'running' && s && analysisAbandoned(s, now)) {
      return {
        key,
        label,
        state: 'error' as StepState,
        detail: null,
        error: clientError ?? 'niet afgemaakt — deze stap schrijft al uren niets meer',
      }
    }
    const state: StepState = clientError && step.state !== 'running' ? 'error' : step.state
    return {
      key,
      label,
      state,
      detail: state === 'done' ? summarizeCounts(step.counts) : null,
      error: step.error ?? clientError,
    }
  })
}

/**
 * How much of the whole scan is behind us, and the ONE line describing it.
 *
 * The panel used to render nine rows, each with a label, a count and
 * sometimes an error — a wall of text for a thing whose only real question is
 * "is it still going, and how far". This collapses that into a bar and a
 * sentence; the rows still exist behind a toggle, because a scan that failed
 * has to be able to say which step failed.
 *
 * WEIGHTING. Steps are not equal. `sentiment` and `subcultures` are seconds of
 * Firestore compute; the detect fan-out is the overwhelming majority of a
 * scan's wall-clock time, and a bar that gave it one ninth would sprint to 78%
 * and then appear frozen for the rest of the run. So analysis carries four
 * units against one for everything else — a judgement about proportion, not a
 * measurement, but far closer than equal weighting.
 *
 * A terminal step counts as travelled whether it succeeded, was skipped or
 * failed: the bar reports how much of the scan is BEHIND us, and a failed step
 * is not coming back. Whether that is bad news is the line's job, not the
 * bar's.
 */
export const ANALYSIS_WEIGHT = 4

export type Overall = {
  /** 0–100, monotonic within a session. */
  pct: number
  /** The single line under the bar. Already includes counts where they matter. */
  label: string
  tone: 'accent' | 'good' | 'bad'
  /** Work is genuinely in flight — the line animates and the bar stripes. */
  busy: boolean
}

export function overallProgress(
  s: ScanState | null,
  clientErrors: Partial<Record<ScanStepKey, string>> = {},
  now = Date.now(),
): Overall | null {
  const phase = scanPhase(s, now)
  if (phase === 'idle') return null

  const views = stepViews(s, clientErrors, now)
  const weightOf = (v: StepView) => (v.key === ANALYSIS_KEY ? ANALYSIS_WEIGHT : 1)

  let travelled = 0
  let total = 0
  for (const v of views) {
    const w = weightOf(v)
    total += w
    if (v.state === 'done' || v.state === 'skipped' || v.state === 'error') travelled += w
    else if (v.state === 'running' && v.key === ANALYSIS_KEY) {
      // The only step that can report its own fraction.
      const a = analysisProgress(s, now)
      if (a) travelled += w * (a.pct / 100)
    }
  }
  const pct = total > 0 ? Math.round((travelled / total) * 100) : 0

  // The line. First a running step, because that is what "now" means; then
  // failure, because a stopped scan owes the reader a reason; then done.
  const running = views.find((v) => v.state === 'running')
  if (running) {
    return {
      pct,
      label: running.detail ? `${running.label} · ${running.detail}` : running.label,
      tone: 'accent',
      busy: true,
    }
  }

  const failed = views.find((v) => v.state === 'error')
  if (failed) {
    return {
      pct,
      label: failed.error ? `${failed.label} — ${failed.error}` : `${failed.label} is niet afgemaakt`,
      tone: 'bad',
      busy: false,
    }
  }

  if (phase === 'stalled') {
    return { pct, label: 'Scan reageert niet meer', tone: 'bad', busy: false }
  }

  if (phase === 'done') {
    const hits = s?.detectionsHit ?? 0
    return {
      pct: 100,
      label: hits > 0 ? `Scan afgerond · ${hits} treffers` : 'Scan afgerond',
      tone: 'good',
      busy: false,
    }
  }

  // Nothing running, nothing failed, and not finished either: between steps,
  // or waiting for a fan-out that has not reported yet. This branch used to
  // return a hardcoded 100 with "Scan afgerond", so a scan that had merely
  // gone quiet for a moment announced itself as complete — and the bar could
  // never come back down from 100 afterwards.
  return { pct, label: 'Scan bezig', tone: 'accent', busy: true }
}

/** A handler's return dict, rendered as one short line. */
function summarizeCounts(counts: Record<string, number> | undefined): string | null {
  if (!counts) return null
  const parts: string[] = []
  const LABELS: Record<string, string> = {
    storiesFound: 'stories',
    accountsChecked: 'accounts',
    creators_scanned: 'creators',
    posts_added: 'posts',
    postsWritten: 'posts',
    hashtagDone: 'tags',
    scored: 'gescoord',
    updated: 'bijgewerkt',
  }
  for (const [k, label] of Object.entries(LABELS)) {
    const v = counts[k]
    if (typeof v === 'number' && v > 0) parts.push(`${v} ${label}`)
    if (parts.length === 2) break
  }
  return parts.length ? parts.join(' · ') : null
}

export function scanHeadline(s: ScanState | null, now = Date.now()):
  { title: string; sub: string | null; tone: 'accent' | 'good' | 'bad' | 'muted' } {
  const phase = scanPhase(s, now)
  const analysis = analysisProgress(s, now)
  switch (phase) {
    case 'idle':
      return { title: 'Nog geen scan gedraaid', sub: null, tone: 'muted' }
    case 'scraping':
      return { title: 'Bezig met scannen', sub: 'content ophalen bij Instagram en TikTok', tone: 'accent' }
    case 'analysing':
      return {
        title: 'Beelden analyseren',
        sub: analysis ? `${analysis.done} van ${analysis.total} · ${s?.detectionsHit ?? 0} hits` : null,
        tone: 'accent',
      }
    case 'stalled':
      return {
        title: 'Scan lijkt vastgelopen',
        sub: 'geen activiteit in 5 minuten — start opnieuw',
        tone: 'bad',
      }
    case 'error':
      return { title: 'Scan afgerond met fouten', sub: 'zie de stappen hieronder', tone: 'bad' }
    default:
      return {
        title: 'Scan afgerond',
        sub: s ? `${s.postsWritten ?? 0} posts · ${s.detectionsHit ?? 0} hits` : null,
        tone: 'good',
      }
  }
}
