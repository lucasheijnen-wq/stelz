// Number and date formatting, pinned to nl-NL.
//
// This is not cosmetic. toLocaleString() with no locale follows the VIEWER's
// browser, so the same dashboard printed "1,284" on the client's machine and
// "1.284" on ours — for a screen shown in client meetings, that is a bug you
// only notice in the meeting. Formatting decisions live here so they are
// testable and so there is one place to change them.

const NL = 'nl-NL'

/** Thousands-grouped integer: 1284 → "1.284". */
export function fmtNum(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  return Math.round(n).toLocaleString(NL)
}

/** Compact, Dutch decimal comma: 1200 → "1,2k", 1_200_000 → "1,2M". */
export function compactNum(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${trimZero((n / 1_000_000).toFixed(1))}M`
  if (abs >= 1_000) return `${trimZero((n / 1_000).toFixed(1))}k`
  return String(Math.round(n))
}

function trimZero(s: string): string {
  // "1.0" → "1", "1.2" → "1,2" — the comma is the Dutch decimal separator.
  return s.replace(/\.0$/, '').replace('.', ',')
}

/** Short date: "20 aug". Add the year only when it isn't the current one. */
export function fmtDate(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const sameYear = d.getFullYear() === now.getFullYear()
  return d.toLocaleDateString(NL, sameYear
    ? { day: 'numeric', month: 'short' }
    : { day: 'numeric', month: 'short', year: 'numeric' })
}

/** Relative age in Dutch: "nu", "3 min", "5 u", "2 d", then a date. */
export function timeAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return '—'
  const mins = Math.floor((now - t) / 60_000)
  if (mins < 1) return 'nu'
  if (mins < 60) return `${mins} min`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} u`
  const days = Math.floor(hours / 24)
  if (days < 14) return `${days} d`
  return fmtDate(iso, new Date(now))
}

/** Follower counts are frequently absent — Instagram's hashtag scrape simply
 *  does not return them. Rendering the absence as "0 followers" states
 *  something false about the creator; omitting the line states nothing. */
export function formatFollowers(n: number | null | undefined): string | null {
  return n && n > 0 ? n.toLocaleString() : null
}
