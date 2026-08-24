// Scan progress, visible.
//
// What existed: one 32px pill (hidden entirely below the sm breakpoint) with a
// 16x2 pixel progress bar, representing one of seven steps. The rest ran
// invisibly and failed silently.
//
// What this is: a stepper. Eight rows, live per-step state, counts when a step
// finishes, the server's error text when it doesn't, and a real bar for the
// detect fan-out — which is where nearly all the wall-clock time goes.
// Separation is by border only: box-shadow is globally disabled by the brand.

import { useState } from 'react'
import { Card } from './ui'
import { useNow } from '../lib/useNow'
import { analysisProgress, scanHeadline, scanPhase, stepViews, type StepView } from '../lib/scanProgress'
import type { ScanState, ScanStepKey } from '../lib/firestore'

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
  const headline = scanHeadline(scan, now)
  const steps = stepViews(scan, clientErrors, now)
  const analysis = analysisProgress(scan, now)
  const busy = phase === 'scraping' || phase === 'analysing'
  const [open, setOpen] = useState(defaultOpen ?? false)

  // Expand on its own when something is happening or something broke; a
  // finished scan collapses back to one line.
  //
  // Adjusted DURING RENDER on a phase change rather than in an effect. React
  // supports this shape for exactly this purpose and it re-renders before
  // painting, so the panel never shows one frame collapsed and then jumps.
  // The effect version wrote state on every run where the condition still held,
  // which meant a panel the user had collapsed sprang back open on the next
  // unrelated re-render.
  const [lastPhase, setLastPhase] = useState(phase)
  if (lastPhase !== phase) {
    setLastPhase(phase)
    if (busy || phase === 'error' || phase === 'stalled') setOpen(true)
  }

  if (phase === 'idle') return null

  const toneClass = {
    accent: 'text-[var(--color-accent)]',
    good: 'text-[var(--color-good)]',
    bad: 'text-[var(--color-bad)]',
    muted: 'text-[var(--color-ink-subtle)]',
  }[headline.tone]

  return (
    <Card className="mb-6">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left"
      >
        <StepGlyph state={busy ? 'running' : phase === 'error' || phase === 'stalled' ? 'error' : 'done'} />
        <span className="min-w-0 flex-1">
          <span className={`block text-[13px] font-medium ${toneClass}`}>{headline.title}</span>
          {headline.sub && (
            <span className="block text-[11px] text-[var(--color-ink-subtle)] tabular-nums">{headline.sub}</span>
          )}
        </span>
        <span className="text-[11px] text-[var(--color-ink-subtle)] shrink-0">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <ul className="border-t border-[var(--color-border)] divide-y divide-[var(--color-border)]">
          {steps.map((s) => (
            <StepRow key={s.key} step={s} analysisPct={s.key === 'analysis' ? analysis?.pct ?? null : null} />
          ))}
        </ul>
      )}
    </Card>
  )
}

function StepRow({ step, analysisPct }: { step: StepView; analysisPct: number | null }) {
  const muted = step.state === 'pending' || step.state === 'skipped'
  return (
    <li className="relative flex items-center gap-3 px-4 py-2">
      <StepGlyph state={step.state} />
      <span className={`text-[12px] ${muted ? 'text-[var(--color-ink-subtle)]' : ''}`}>{step.label}</span>
      <span className="ml-auto text-[11px] text-[var(--color-ink-subtle)] tabular-nums text-right">
        {step.state === 'skipped' ? '–' : step.detail}
      </span>
      {step.error && (
        <span className="absolute left-11 bottom-0.5 text-[10px] text-[var(--color-bad)] truncate max-w-[80%]">
          {step.error}
        </span>
      )}
      {/* The bar the old UI rendered 16 pixels wide, at full row width. */}
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
