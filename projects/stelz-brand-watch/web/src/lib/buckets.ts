// Timestamps naar een reeks van precies `days` dagen, ook de lege.
//
// Stond in components/Chart.tsx. Een bestand dat componenten exporteert moet
// alleen componenten exporteren, anders valt Fast Refresh bij elke wijziging
// terug op een volledige herlaadbeurt van de pagina — en dit is een pure
// functie die acht bestanden gebruiken zonder ooit een grafiek te tekenen.

import type { DayPoint } from '../components/Chart'

export function bucketByDay(timestamps: (string | null)[], days = 30): DayPoint[] {
  const buckets = new Map<string, number>()
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(today)
    d.setDate(today.getDate() - i)
    buckets.set(d.toISOString().slice(0, 10), 0)
  }
  for (const t of timestamps) {
    if (!t) continue
    const key = t.slice(0, 10)
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1)
  }
  return [...buckets.entries()].map(([d, n]) => ({ d, n }))
}
