// Scan progress: one bar, one line.
//
// What existed before this: nine rows, each with a label, a count and
// sometimes an error, and the errors were absolutely positioned into rows that
// reserved no height for them — so "niet afgemaakt — deze stap schrijft al
// uren niets meer" printed straight through "Hashtags scrapen". A wall of text
// that also overlapped itself.
//
// A running scan has one question: is it still going, and how far along. So
// that is what the panel is now — a bar, and beneath it a single line naming
// what is happening, which cross-fades when it changes.
//
// THE ROWS STILL EXIST, behind a toggle that is closed by default. A scan that
// failed has to be able to say WHICH step failed; collapsing that away
// entirely would trade a cluttered panel for a dishonest one. The line carries
// the failure, the rows carry the detail.
//
// Separation is by border only: box-shadow is globally disabled by the brand.

import { useState } from 'react'
import { Card } from './ui'
import { useNow } from '../lib/useNow'
import { analysisProgress, overallProgress, scanPhase, stepViews, type StepView } from '../lib/scanProgress'
import { fbResumeAnalysis, type ScanState, type ScanStepKey } from '../lib/firestore'
import { useMembership } from '../lib/membershipContext'

export function ScanPanel({
  scan,
  clientErrors = {},
  defaultOpen,
}: {
  scan: ScanState | null
  clientErrors?: Partial<Record<ScanStepKey, string>>
  defaultOpen?: boolean
}) {
  // Re-render on a timer: staleness and the ETA are functions of wall-clock
  // time, so a snapshot-only render can sit on "3 min left" indefinitely.
  const now = useNow(5_000)

  const phase = scanPhase(scan, now)
  const overall = overallProgress(scan, clientErrors, now)
  const steps = stepViews(scan, clientErrors, now)
  const analysis = analysisProgress(scan, now)
  const [open, setOpen] = useState(defaultOpen ?? false)

  if (phase === 'idle' || !overall) return null

  const toneClass = {
    accent: 'text-[var(--color-ink-muted)]',
    good: 'text-[var(--color-good)]',
    bad: 'text-[var(--color-bad)]',
  }[overall.tone]
  const barClass = overall.tone === 'bad' ? 'bg-[var(--color-bad)]' : 'bg-[var(--color-accent)]'

  return (
    <Card className="mb-6 px-4 py-3">
      <div className="flex items-center gap-3">
        <div className="h-1 flex-1 bg-[var(--color-border)] overflow-hidden">
          <div
            className={`h-full ${barClass} transition-[width] duration-700 ease-out`}
            style={{ width: `${overall.pct}%` }}
          />
        </div>
        <span className="text-[11px] tabular-nums text-[var(--color-ink-subtle)] shrink-0 w-9 text-right">
          {overall.pct}%
        </span>
        {/* Discreet, because the detail is the exception and not the point. */}
        <button
          onClick={() => setOpen((v) => !v)}
          className="text-[11px] text-[var(--color-ink-subtle)] shrink-0 w-4 text-right"
          aria-label={open ? 'Verberg stappen' : 'Toon stappen'}
        >
          {open ? '▴' : '▾'}
        </button>
      </div>

      {/* THE LINE. Keyed on its own text so React remounts it when the text
          changes, which is what restarts the fade — a plain <span> whose
          content changes would swap the words with no transition at all. */}
      <div className="mt-2 flex items-baseline gap-3">
        <div className="min-w-0 flex-1 h-4 overflow-hidden">
          <span
            key={overall.label}
            className={`block text-[12px] leading-4 truncate animate-[scanline_400ms_ease-out] ${toneClass}`}
          >
            {overall.busy && (
              <span className="inline-block w-1 h-1 mb-0.5 mr-1.5 rounded-full bg-[var(--color-accent)] animate-pulse" />
            )}
            {overall.label}
          </span>
        </div>
        {/* The repair, offered where the damage is visible. Only when work was
            actually lost — a running scan does not need resuming. */}
        {overall.tone === 'bad' && <ResumeButton />}
      </div>

      {open && (
        <ul className="mt-3 border-t border-[var(--color-border)] divide-y divide-[var(--color-border)]">
          {steps.map((s) => (
            <StepRow key={s.key} step={s} analysisPct={s.key === 'analysis' ? analysis?.pct ?? null : null} />
          ))}
        </ul>
      )}
    </Card>
  )
}

/**
 * "Hervatten" — re-analyse media that never produced a verdict.
 *
 * A stalled fan-out could previously only be recovered by re-running the whole
 * scrape, which pays Apify a second time for posts already on disk. This pays
 * nothing to Apify: the media is harvested, only the analysis is missing. The
 * server finds the gap in the data (posts with no detection document) rather
 * than from the counter, which counts publish attempts and cannot name a file.
 */
function ResumeButton() {
  const { canWrite } = useMembership()
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'error'>('idle')
  const [note, setNote] = useState<string | null>(null)
  if (!canWrite) return null

  const go = async () => {
    setState('busy')
    setNote(null)
    try {
      const out = await fbResumeAnalysis() as {
        posts_without_analysis?: number; images_enqueued?: number
        videos_enqueued?: number; skipped?: string
      }
      if (out.skipped) {
        setState('error')
        setNote(out.skipped === 'budget_exhausted'
          ? 'dagbudget op'
          : `overgeslagen: ${out.skipped}`)
        return
      }
      const n = (out.images_enqueued ?? 0) + (out.videos_enqueued ?? 0)
      setState('done')
      // Zero is a real answer and worth saying: it means nothing was lost that
      // this can reach, which is different from "it worked".
      setNote(n > 0
        ? `${n} beelden opnieuw aangeboden`
        : 'niets te hervatten — alles heeft al een oordeel')
    } catch (e) {
      setState('error')
      setNote((e as Error).message)
    }
  }

  if (state === 'done' || (state === 'error' && note)) {
    return <span className="text-[11px] text-[var(--color-ink-subtle)] shrink-0">{note}</span>
  }
  return (
    <button
      onClick={() => { void go() }}
      disabled={state === 'busy'}
      className="text-[11px] underline text-[var(--color-ink-muted)] shrink-0 disabled:opacity-50"
      title={'Biedt beelden zonder oordeel opnieuw aan de analyse aan. '
        + 'Kost geen Apify-tegoed — het materiaal is al binnengehaald. '
        + 'Beelden waarvan de CDN-link verlopen is zijn niet meer op te halen.'}
    >
      {state === 'busy' ? 'bezig…' : 'hervatten'}
    </button>
  )
}

function StepRow({ step, analysisPct }: { step: StepView; analysisPct: number | null }) {
  const muted = step.state === 'pending' || step.state === 'skipped'
  return (
    <li className="relative py-2">
      <div className="flex items-center gap-3">
        <StepGlyph state={step.state} />
        <span className={`text-[12px] ${muted ? 'text-[var(--color-ink-subtle)]' : ''}`}>{step.label}</span>
        <span className="ml-auto text-[11px] text-[var(--color-ink-subtle)] tabular-nums text-right">
          {step.state === 'skipped' ? '–' : step.detail}
        </span>
      </div>
      {/* IN FLOW, not absolutely positioned. The old version placed this over
          the row with `absolute bottom-0.5` while the row reserved no height
          for it, so every error printed through its own step's label. */}
      {step.error && (
        <div className="mt-0.5 pl-5 text-[10px] leading-snug text-[var(--color-bad)]">
          {step.error}
        </div>
      )}
      {analysisPct != null && step.state === 'running' && (
        <span className="absolute inset-x-0 bottom-0 h-0.5 bg-[var(--color-border)]">
          <span className="block h-full bg-[var(--color-accent)]" style={{ width: `${analysisPct}%` }} />
        </span>
      )}
    </li>
  )
}

function StepGlyph({ state }: { state: StepView['state'] }) {
  if (state === 'running') {
    return <span className="w-2 h-2 rounded-full bg-[var(--color-accent)] animate-pulse shrink-0" />
  }
  if (state === 'done') return <span className="text-[11px] text-[var(--color-good)] w-2 shrink-0">✓</span>
  if (state === 'error') return <span className="text-[11px] text-[var(--color-bad)] w-2 shrink-0">✕</span>
  if (state === 'skipped') return <span className="text-[11px] text-[var(--color-ink-subtle)] w-2 shrink-0">–</span>
  return <span className="w-2 h-2 border border-[var(--color-border-strong)] shrink-0" />
}

/** A 2px line on the mobile top bar — where there was no progress signal at
 *  all, because the desktop pill is hidden below the sm breakpoint. */
export function ScanProgressLine({ scan }: { scan: ScanState | null }) {
  const phase = scanPhase(scan)
  if (phase !== 'scraping' && phase !== 'analysing') return null
  const a = analysisProgress(scan)
  const pct = a ? a.pct : null
  return (
    <span className="absolute inset-x-0 bottom-0 h-0.5 bg-white/20">
      <span
        className={`block h-full bg-[var(--color-accent)] ${pct == null ? 'animate-pulse w-1/3' : ''}`}
        style={pct == null ? undefined : { width: `${pct}%` }}
      />
    </span>
  )
}
