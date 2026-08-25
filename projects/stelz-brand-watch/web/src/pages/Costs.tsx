// What this tool costs — internal only.
//
// Hidden from read-only viewers, because unit prices reveal margin. Hiding a
// page is not access control, so the enforcement lives in firestore.rules:
// `match /usage/{day}` requires brand membership, AND the recursive catch-all
// underneath it excludes 'usage' by name. Both halves are needed — Firestore
// evaluates every matching rule and grants the read if any one of them allows
// it, so a stricter rule placed "above" a broader one changes nothing.
//
// Every figure is an ESTIMATE from measured unit prices, not an invoice, and
// the page says so. Cloud Functions, Firestore and Storage are not counted.

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { PageShell, Card, Badge } from '../components/ui'
import { StackedDayBars, type DayPoint, type Series } from '../components/Chart'
import {
  fbListUsage, fbGetBrand, fbFetchCreatorProfiles,
  type UsageDay, type BrandDoc, type CreatorProfile,
} from '../lib/firestore'
import {
  UNIT_META, VOLUME_COUNTERS, COST_PER_UNIT,
  degradeLevel, DEGRADE_LABEL, DEGRADE_NOTE,
  recipes, projection, fmtUsd, spendBreakdown,
} from '../lib/costs'
import { fmtNum, fmtDate } from '../lib/format'
import { useMembership } from '../lib/membershipContext'
const DAYS = 14

export default function Costs() {
  const { canWrite } = useMembership()
  const [usage, setUsage] = useState<UsageDay[]>([])
  const [brand, setBrand] = useState<BrandDoc | null>(null)
  const [profiles, setProfiles] = useState<Record<string, CreatorProfile>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // No write access means nothing to fetch. Nothing to clear either: the
    // admin-only card below never reads `loading`, so the setLoading(false)
    // that used to sit here only existed to make a spinner nobody sees stop.
    if (!canWrite) return
    let cancelled = false
    void Promise.all([
      fbListUsage(DAYS),
      fbGetBrand(),
      fbFetchCreatorProfiles().catch(() => ({} as Record<string, CreatorProfile>)),
    ]).then(([u, b, p]) => {
      if (cancelled) return
      setUsage(u); setBrand(b); setProfiles(p)
    }).catch((e) => { if (!cancelled) setError((e as Error).message) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [canWrite])

  // What a story sweep actually submits: Instagram creators on tier 1 or 2.
  const trackedHandles = useMemo(
    () => Object.values(profiles).filter(
      (p) => p.platform === 'instagram' && (p.tier === 'tier_1' || p.tier === 'tier_2'),
    ).length,
    [profiles],
  )

  // Totals per unit over the window, so the biggest cost driver is obvious.
  const totals = useMemo(() => {
    const merged: Record<string, number> = {}
    for (const d of usage) {
      for (const [k, v] of Object.entries(d.counters)) merged[k] = (merged[k] ?? 0) + v
    }
    return { merged, ...spendBreakdown(merged) }
  }, [usage])

  // Built directly rather than through bucketByDay, which counts EVENTS: a
  // $57 day would mean allocating 5,700 dummy timestamps to draw one bar.
  const trend: Series = useMemo(() => {
    const byDay = new Map(usage.map((d) => [d.day, d.estimatedSpendUsd]))
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const data: DayPoint[] = []
    for (let i = DAYS - 1; i >= 0; i--) {
      const d = new Date(today)
      d.setDate(today.getDate() - i)
      const key = d.toISOString().slice(0, 10)
      data.push({ d: key, n: Math.round((byDay.get(key) ?? 0) * 100) })
    }
    return { id: 'spend', label: 'Uitgaven', tone: 'accent', data }
  }, [usage])

  // EVERY HOOK IS ABOVE THIS LINE, and it has to stay that way. This return
  // used to sit above the two useMemos: the moment `canWrite` flipped from
  // false to true — which is exactly what happens when membership resolves a
  // moment after first paint — React saw two extra hooks appear and threw
  // "Rendered more hooks than during the previous render", taking the page out
  // rather than showing the numbers it had just loaded.
  if (!canWrite) {
    return (
      <PageShell title="Kosten">
        <Card className="p-12 text-center text-[13px] text-[var(--color-ink-muted)]">
          Deze pagina is alleen voor beheerders.
        </Card>
      </PageShell>
    )
  }

  const budget = brand?.dailyBudgetUsd ?? 5
  const today = usage[0]
  const spendToday = today?.estimatedSpendUsd ?? 0
  const rung = degradeLevel(spendToday, budget)
  const total = usage.reduce((s, d) => s + d.estimatedSpendUsd, 0)
  const proj = projection(trackedHandles, brand?.storiesAutoScan === true)

  return (
    <PageShell
      title="Kosten"
      subtitle="Alleen zichtbaar voor beheerders"
      crumbs={[{ label: 'Overzicht', to: '/' }]}
    >
      {error && <Card className="mb-6 p-4 text-[12px] text-[var(--color-bad)]">{error}</Card>}

      {loading ? (
        <Card className="p-14 text-center text-[13px] text-[var(--color-ink-subtle)]">Laden…</Card>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4">
            <Kpi label="Vandaag" value={fmtUsd(spendToday)} sub={`van $${budget.toFixed(2)} dagbudget`} />
            <Kpi label={`Laatste ${DAYS} dagen`} value={fmtUsd(total)}
                 sub={usage.length ? `${usage.length} dagen met verbruik` : 'nog geen verbruik'} />
            <Kpi label="Stand" value={DEGRADE_LABEL[rung]} sub={DEGRADE_NOTE[rung]} />
            <Kpi
              label="Vast per maand"
              value={fmtUsd(proj.fixedPerMonth)}
              sub={proj.fixedNote}
            />
          </div>

          <Card className="mb-6 px-4 py-3 text-[12px] text-[var(--color-ink-muted)] leading-relaxed">
            <strong className="font-medium text-[var(--color-ink)]">Dit is een schatting.</strong>{' '}
            Berekend uit gemeten tarieven per eenheid, niet uit een factuur van Google of Apify.
            Kosten voor Cloud Functions, Firestore en opslag zitten er niet in — klein op dit
            volume, maar niet nul. Het dagbudget pas je aan in{' '}
            <Link to="/settings" className="underline hover:text-[var(--color-ink)]">Instellingen</Link>.
          </Card>

          {/* ── Wat kost één actie ── */}
          <Card className="mb-6">
            <div className="px-4 py-3 border-b border-[var(--color-border)]">
              <h2 className="text-[13px] font-medium">Wat kost één actie</h2>
              <p className="text-[11px] text-[var(--color-ink-subtle)] mt-0.5">
                Met de rekensom erbij, zodat elk bedrag na te rekenen is.
              </p>
            </div>
            <table className="w-full text-[12px]">
              <tbody>
                {recipes(trackedHandles).map((r) => (
                  <tr key={r.id} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="px-4 py-2.5">{r.label}</td>
                    <td className="px-3 py-2.5 text-[var(--color-ink-subtle)] hidden sm:table-cell">
                      {r.formula}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums font-medium">
                      {fmtUsd(r.usd)}
                      {r.usd > budget && (
                        <span className="ml-2"><Badge tone="bad">boven dagbudget</Badge></span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="px-4 py-3 text-[11px] text-[var(--color-ink-muted)] border-t border-[var(--color-border)] leading-relaxed">
              De hashtag-scan is met afstand de duurste knop: Apify rekent per resultaat, en de
              standaardinstelling haalt er {fmtNum(500 * 50)} op. Het dagbudget grijpt onderweg in
              (de "stand" hierboven), dus in de praktijk wordt zo'n scan afgeknepen in plaats van
              volledig afgerekend.
            </p>
          </Card>

          {/* ── Waar het geld heen ging ── */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
            <Card className="p-5">
              <h3 className="text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)] mb-3">
                Uitgaven per dag
              </h3>
              <StackedDayBars series={[trend]} height={150} days={DAYS} />
              <p className="text-[10px] text-[var(--color-ink-subtle)] mt-2">Hoogte in centen.</p>
            </Card>

            <Card className="p-5">
              <h3 className="text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)] mb-3">
                Waar het geld heen ging ({DAYS} dagen)
              </h3>
              {totals.lines.length === 0 ? (
                <p className="text-[12px] text-[var(--color-ink-muted)] py-6 text-center">
                  Nog geen verbruik geregistreerd.
                </p>
              ) : (
                <dl className="space-y-2.5 text-[12px]">
                  {totals.lines.map((l) => (
                    <div key={l.key}>
                      <div className="flex items-baseline justify-between gap-3">
                        <dt>{UNIT_META[l.key]?.label ?? l.key}</dt>
                        <dd className="tabular-nums font-medium shrink-0">{fmtUsd(l.usd)}</dd>
                      </div>
                      <div className="text-[10px] text-[var(--color-ink-subtle)] tabular-nums">
                        {fmtNum(l.units)} × {fmtUsd(COST_PER_UNIT[l.key])}
                      </div>
                    </div>
                  ))}
                </dl>
              )}
            </Card>
          </div>

          {/* ── Volume zonder prijs ── */}
          <Card className="mb-6 p-5">
            <h3 className="text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)] mb-3">
              Geteld, maar gratis
            </h3>
            <dl className="grid grid-cols-2 sm:grid-cols-3 gap-4 text-[12px]">
              {Object.entries(VOLUME_COUNTERS).map(([k, label]) => (
                <div key={k}>
                  <dt className="text-[var(--color-ink-muted)]">{label}</dt>
                  <dd className="tabular-nums font-medium">{fmtNum(totals.merged[k] ?? 0)}</dd>
                </div>
              ))}
            </dl>
            {Object.entries(UNIT_META).filter(([, m]) => !m.recorded).map(([k, m]) => (
              <p key={k} className="text-[11px] text-[var(--color-ink-subtle)] mt-3">
                {m.label}: {m.note}
              </p>
            ))}
          </Card>

          {/* ── Per dag ── */}
          <Card className="overflow-x-auto">
            <table className="w-full text-[12px] min-w-[520px]">
              <thead>
                <tr className="text-[10px] uppercase tracking-widest text-[var(--color-ink-subtle)] border-b border-[var(--color-border)]">
                  <th className="text-left font-normal px-4 py-2.5">Dag</th>
                  <th className="text-right font-normal px-3 py-2.5">Grootste post</th>
                  <th className="text-right font-normal px-3 py-2.5">Analyses</th>
                  <th className="text-right font-normal px-4 py-2.5">Schatting</th>
                </tr>
              </thead>
              <tbody>
                {usage.length === 0 ? (
                  <tr><td colSpan={4} className="px-4 py-8 text-center text-[var(--color-ink-muted)]">
                    Nog geen verbruiksdagen vastgelegd.
                  </td></tr>
                ) : usage.map((d) => (
                  <tr key={d.day} className="border-b border-[var(--color-border)] last:border-0">
                    <td className="px-4 py-2.5">{fmtDate(`${d.day}T12:00:00Z`)}</td>
                    <td className="px-3 py-2.5 text-right text-[var(--color-ink-subtle)]">
                      {d.lines[0] ? (UNIT_META[d.lines[0].key]?.label ?? d.lines[0].key) : '—'}
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums">
                      {fmtNum(d.counters.detections_written ?? 0)}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums font-medium">
                      {fmtUsd(d.estimatedSpendUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          <p className="text-[11px] text-[var(--color-ink-subtle)] mt-4 leading-relaxed">
            Per handmatige scan: hashtag-scan {fmtUsd(proj.perHashtagScan)} · creator-scan{' '}
            {fmtUsd(proj.perCreatorScan)}. Die staan niet in de maandprojectie hierboven, want
            hoe vaak erop geklikt wordt is geen aanname die deze pagina hoort te doen.
          </p>
        </>
      )}
    </PageShell>
  )
}

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <Card className="p-4">
      <div className="text-[10px] uppercase tracking-widest text-[var(--color-ink-subtle)] mb-1.5">{label}</div>
      <div className="stelz-display text-[24px] leading-none text-[var(--color-ink)]">{value}</div>
      {sub && <div className="text-[11px] text-[var(--color-ink-subtle)] mt-1.5 leading-snug">{sub}</div>}
    </Card>
  )
}
