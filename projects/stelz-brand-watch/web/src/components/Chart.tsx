import { useMemo, useRef, useState } from 'react'

export type DayPoint = { d: string; n: number }
export type Series = { id: string; label: string; data: DayPoint[]; tone?: 'ink' | 'accent' | 'good' | 'bad' }

const TONE: Record<NonNullable<Series['tone']>, string> = {
  ink: 'var(--color-ink)',
  accent: 'var(--color-accent)',
  good: 'var(--color-good)',
  bad: 'var(--color-bad)',
}


export function Sparkline({ data, height = 28, tone = 'ink' }: { data: DayPoint[]; height?: number; tone?: Series['tone'] }) {
  if (!data.length) return null
  const max = Math.max(1, ...data.map((p) => p.n))
  const w = data.length * 4
  const path = data
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${i * 4} ${height - (p.n / max) * height}`)
    .join(' ')
  // Area fill
  const area = `${path} L ${(data.length - 1) * 4} ${height} L 0 ${height} Z`
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="w-full h-7">
      <path d={area} fill={TONE[tone ?? 'ink']} opacity="0.08" />
      <path d={path} fill="none" stroke={TONE[tone ?? 'ink']} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

export function LineChart({
  series,
  height = 240,
  yFormat,
}: {
  series: Series[]
  height?: number
  yFormat?: (n: number) => string
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null)
  const svgRef = useRef<SVGSVGElement | null>(null)
  const wrapperRef = useRef<HTMLDivElement | null>(null)

  const all = series.flatMap((s) => s.data.map((p) => p.n))
  const max = Math.max(1, ...all)
  const len = series[0]?.data.length ?? 0

  const padL = 40
  const padR = 16
  const padTop = 16
  const padBottom = 26
  const w = 800
  const innerW = w - padL - padR
  const innerH = height - padTop - padBottom
  const stepX = len > 1 ? innerW / (len - 1) : 0

  // Gememoiseerd omdat de fallback anders bij elke render een nieuwe functie is,
  // waardoor het gridY-useMemo hieronder zijn hele rooster elke render opnieuw
  // uitrekende — een memo die niets bespaarde.
  const fmt = useMemo(() => yFormat ?? ((n: number) => n.toString()), [yFormat])

  const gridY = useMemo(() => {
    const ticks = 4
    return Array.from({ length: ticks + 1 }).map((_, i) => {
      const ratio = i / ticks
      return {
        y: padTop + innerH * ratio,
        label: fmt(Math.round(max * (1 - ratio))),
      }
    })
  }, [max, fmt, innerH])

  const xTicks = useMemo(() => {
    if (!len) return []
    const positions = [0, Math.floor(len * 0.25), Math.floor(len * 0.5), Math.floor(len * 0.75), len - 1]
    return positions.map((i) => ({ i, x: padL + i * stepX, label: fmtShort(series[0].data[i]?.d ?? '') }))
  }, [len, stepX, series])

  function handleMove(e: React.MouseEvent<SVGSVGElement>) {
    const svg = svgRef.current
    if (!svg || !len) return
    const rect = svg.getBoundingClientRect()
    const relX = ((e.clientX - rect.left) / rect.width) * w
    const i = Math.round((relX - padL) / stepX)
    setHoverIdx(Math.max(0, Math.min(len - 1, i)))
  }

  const hoverDate = hoverIdx != null ? series[0]?.data[hoverIdx]?.d : null

  return (
    <div ref={wrapperRef} className="relative w-full">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${w} ${height}`}
        className="w-full h-auto"
        preserveAspectRatio="none"
        onMouseMove={handleMove}
        onMouseLeave={() => setHoverIdx(null)}
      >
        {/* Y grid + labels */}
        {gridY.map((g, i) => (
          <g key={i}>
            <line x1={padL} x2={w - padR} y1={g.y} y2={g.y} stroke="var(--color-border)" strokeWidth="1" />
            <text x={padL - 8} y={g.y + 3} fill="var(--color-ink-subtle)" fontSize="9" textAnchor="end">{g.label}</text>
          </g>
        ))}

        {/* Series */}
        {series.map((s) => {
          const stroke = TONE[s.tone ?? 'ink']
          const path = s.data
            .map((p, i) => `${i === 0 ? 'M' : 'L'} ${padL + i * stepX} ${padTop + innerH - (p.n / max) * innerH}`)
            .join(' ')
          const area = `${path} L ${padL + (s.data.length - 1) * stepX} ${padTop + innerH} L ${padL} ${padTop + innerH} Z`
          return (
            <g key={s.id}>
              {series.length === 1 && <path d={area} fill={stroke} opacity="0.06" />}
              <path d={path} fill="none" stroke={stroke} strokeWidth="1.5" />
            </g>
          )
        })}

        {/* X ticks */}
        {xTicks.map((t) => (
          <text key={t.i} x={t.x} y={height - 8} fill="var(--color-ink-subtle)" fontSize="10" textAnchor="middle">
            {t.label}
          </text>
        ))}

        {/* Hover line + dots */}
        {hoverIdx != null && (
          <>
            <line
              x1={padL + hoverIdx * stepX}
              x2={padL + hoverIdx * stepX}
              y1={padTop}
              y2={padTop + innerH}
              stroke="var(--color-ink)"
              strokeWidth="1"
              strokeDasharray="2 3"
              opacity="0.4"
            />
            {series.map((s) => {
              const p = s.data[hoverIdx]
              if (!p) return null
              return (
                <circle
                  key={s.id}
                  cx={padL + hoverIdx * stepX}
                  cy={padTop + innerH - (p.n / max) * innerH}
                  r="3.5"
                  fill="var(--color-surface)"
                  stroke={TONE[s.tone ?? 'ink']}
                  strokeWidth="1.5"
                />
              )
            })}
          </>
        )}
      </svg>

      {/* Tooltip */}
      {hoverIdx != null && hoverDate && (
        <div
          className="pointer-events-none absolute top-2 bg-[var(--color-ink)] text-white px-3 py-2 text-[11px] leading-tight"
          style={{
            left: `${Math.min(85, ((padL + hoverIdx * stepX) / w) * 100)}%`,
            transform: 'translateX(8px)',
          }}
        >
          <div className="text-[10px] uppercase tracking-widest opacity-60 mb-1.5 tabular-nums">{fmtFull(hoverDate)}</div>
          {series.map((s) => (
            <div key={s.id} className="flex items-center gap-2 tabular-nums">
              <span className="w-1.5 h-1.5" style={{ background: TONE[s.tone ?? 'ink'] }} />
              <span className="opacity-70">{s.label}</span>
              <span className="ml-auto pl-3">{fmt(s.data[hoverIdx]?.n ?? 0)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Legend */}
      {series.length > 1 && (
        <div className="flex items-center gap-4 mt-3 text-[11px]">
          {series.map((s) => (
            <span key={s.id} className="flex items-center gap-2 text-[var(--color-ink-muted)]">
              <span className="w-2.5 h-px" style={{ background: TONE[s.tone ?? 'ink'], height: '2px' }} />
              {s.label}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── BarChart ─────────────────────────────────────────────────────────────
// Horizontal bars; takes [{label, value, tone?}], sorted highest-first.

export type BarRow = { label: string; value: number; sub?: string; tone?: Series['tone']; color?: string }

export function BarChart({ rows, max, valueFmt }: { rows: BarRow[]; max?: number; valueFmt?: (n: number) => string }) {
  if (!rows.length) return <EmptyState label="No data yet" />
  const cap = max ?? Math.max(1, ...rows.map((r) => r.value))
  return (
    <div className="space-y-2">
      {rows.map((r) => {
        const pct = Math.max(0, Math.min(100, (r.value / cap) * 100))
        return (
          <div key={r.label} className="group">
            <div className="flex items-baseline justify-between mb-1 text-[12px]">
              <span className="truncate">{r.label}</span>
              <span className="tabular-nums text-[var(--color-ink-muted)] shrink-0 ml-3">
                {valueFmt ? valueFmt(r.value) : r.value.toLocaleString()}
                {r.sub && <span className="text-[var(--color-ink-subtle)] ml-2">{r.sub}</span>}
              </span>
            </div>
            <div className="h-1.5 bg-[var(--color-border)] relative">
              <div
                className="absolute inset-y-0 left-0"
                style={{ width: `${pct}%`, background: r.color ?? TONE[r.tone ?? 'ink'] }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Donut ────────────────────────────────────────────────────────────────
// SVG donut with centre label + side legend.

export type DonutSlice = { label: string; value: number; tone?: Series['tone']; color?: string }

export function Donut({ slices, size = 160, centreLabel, centreSub }: {
  slices: DonutSlice[]
  size?: number
  centreLabel?: string
  centreSub?: string
}) {
  const total = slices.reduce((s, x) => s + x.value, 0)
  if (total === 0) return <EmptyState label="No data yet" />
  const radius = size / 2
  const inner = radius * 0.62
  const cx = radius
  const cy = radius
  // Waar elke schijf begint, vooraf uitgerekend. Dit was een `let acc` die in
  // de map werd opgehoogd: een variabele van buiten de callback die tijdens de
  // render muteert, en daarmee een render die van zijn eigen volgorde afhangt.
  // Draait React de map ooit opnieuw of gedeeltelijk, dan staan de schijven
  // ergens anders. Aantal schijven is een handvol, dus de dubbele lus kost niets.
  const startAt = slices.map(
    (_, i) => slices.slice(0, i).reduce((sum, x) => sum + x.value, 0))

  const arcs = slices.map((s, i) => {
    const a0 = (startAt[i] / total) * Math.PI * 2 - Math.PI / 2
    const a1 = ((startAt[i] + s.value) / total) * Math.PI * 2 - Math.PI / 2
    const large = a1 - a0 > Math.PI ? 1 : 0
    const x0 = cx + Math.cos(a0) * radius
    const y0 = cy + Math.sin(a0) * radius
    const x1 = cx + Math.cos(a1) * radius
    const y1 = cy + Math.sin(a1) * radius
    const ix0 = cx + Math.cos(a0) * inner
    const iy0 = cy + Math.sin(a0) * inner
    const ix1 = cx + Math.cos(a1) * inner
    const iy1 = cy + Math.sin(a1) * inner
    return {
      d: `M ${x0} ${y0} A ${radius} ${radius} 0 ${large} 1 ${x1} ${y1} L ${ix1} ${iy1} A ${inner} ${inner} 0 ${large} 0 ${ix0} ${iy0} Z`,
      fill: s.color ?? TONE[s.tone ?? (['accent', 'ink', 'good', 'bad'] as const)[i % 4]],
      label: s.label,
      value: s.value,
    }
  })
  return (
    <div className="flex items-center gap-6">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="shrink-0">
        {arcs.map((a, i) => (
          <path key={i} d={a.d} fill={a.fill} />
        ))}
        {centreLabel && (
          <text x={cx} y={cy - 4} textAnchor="middle" className="fill-[var(--color-ink)]" style={{ fontSize: 18, fontWeight: 500 }}>
            {centreLabel}
          </text>
        )}
        {centreSub && (
          <text x={cx} y={cy + 14} textAnchor="middle" className="fill-[var(--color-ink-muted)]" style={{ fontSize: 10 }}>
            {centreSub}
          </text>
        )}
      </svg>
      <div className="space-y-1.5 text-[12px] flex-1 min-w-0">
        {arcs.map((a, i) => (
          <div key={i} className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 truncate">
              <span className="inline-block w-2 h-2 rounded-sm shrink-0" style={{ background: a.fill }} />
              <span className="truncate">{a.label}</span>
            </span>
            <span className="tabular-nums text-[var(--color-ink-muted)] shrink-0">
              {a.value.toLocaleString()}
              <span className="text-[var(--color-ink-subtle)] ml-1.5">{((a.value / total) * 100).toFixed(0)}%</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── StackedDayBars ──────────────────────────────────────────────────────
// Vertical bars per day, sub-stacked by series. Used for new creators / day.

export function StackedDayBars({ series, height = 140, days = 30 }: {
  series: Series[]
  height?: number
  days?: number
}) {
  if (!series.length) return <EmptyState label="No data yet" />
  const merged: { d: string; parts: { tone: Series['tone']; n: number }[]; total: number }[] = []
  const dates = series[0].data.map((p) => p.d).slice(-days)
  for (let i = 0; i < dates.length; i++) {
    const parts: { tone: Series['tone']; n: number }[] = []
    let total = 0
    for (const s of series) {
      const n = s.data[s.data.length - dates.length + i]?.n ?? 0
      parts.push({ tone: s.tone, n })
      total += n
    }
    merged.push({ d: dates[i], parts, total })
  }
  const max = Math.max(1, ...merged.map((m) => m.total))
  const barW = Math.max(2, Math.min(14, 600 / merged.length - 2))
  const gap = 2
  const totalW = merged.length * (barW + gap)
  return (
    <div>
      <svg viewBox={`0 0 ${totalW} ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }}>
        {merged.map((m, i) => {
          let y = height
          return (
            <g key={i} transform={`translate(${i * (barW + gap)}, 0)`}>
              {m.parts.map((p, j) => {
                const h = (p.n / max) * (height - 2)
                y -= h
                return <rect key={j} x={0} y={y} width={barW} height={h} fill={TONE[p.tone ?? 'ink']} />
              })}
            </g>
          )
        })}
      </svg>
      <div className="flex justify-between text-[10px] text-[var(--color-ink-subtle)] tabular-nums mt-1">
        <span>{fmtShort(dates[0] ?? '')}</span>
        <span>{fmtShort(dates[dates.length - 1] ?? '')}</span>
      </div>
    </div>
  )
}

// ─── HistogramBands ──────────────────────────────────────────────────────
// Pre-bucketed value bands (e.g. confidence 0-50/50-70/70-85/85-100).

export function HistogramBands({ bands }: { bands: { label: string; value: number; tone?: Series['tone'] }[] }) {
  const total = bands.reduce((s, b) => s + b.value, 0)
  if (total === 0) return <EmptyState label="No data yet" />
  return (
    <div className="space-y-3">
      <div className="flex h-3 overflow-hidden">
        {bands.map((b, i) => {
          const pct = (b.value / total) * 100
          if (pct === 0) return null
          return <div key={i} style={{ width: `${pct}%`, background: TONE[b.tone ?? 'ink'] }} />
        })}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-[11px]">
        {bands.map((b, i) => (
          <div key={i}>
            <div className="flex items-center gap-1.5 mb-0.5">
              <span className="inline-block w-2 h-2 rounded-sm" style={{ background: TONE[b.tone ?? 'ink'] }} />
              <span className="text-[var(--color-ink-muted)]">{b.label}</span>
            </div>
            <div className="tabular-nums">
              {b.value.toLocaleString()}
              <span className="text-[var(--color-ink-subtle)] ml-1.5">{((b.value / total) * 100).toFixed(0)}%</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="text-center py-8 text-[12px] text-[var(--color-ink-subtle)]">{label}</div>
  )
}

function fmtShort(iso: string) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleDateString('nl-NL', { day: '2-digit', month: 'short' })
}

function fmtFull(iso: string) {
  const d = new Date(iso)
  return d.toLocaleDateString('nl-NL', { weekday: 'short', day: '2-digit', month: 'short' })
}
