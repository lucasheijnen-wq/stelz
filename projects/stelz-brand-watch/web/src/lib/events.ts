// Deciding whether a piece of content belongs to an event, and on which side.
//
// WHY THIS FILE EXISTS. The dashboard used to show "Lowlands" over numbers that
// had nothing to do with Lowlands. The archives are "the last N posts by these
// creators", running back to 2021, and nothing anywhere filtered by date. On
// the real fixture that made the festival page report 50 sightings when 8 fell
// in the festival window, and 100.928.763 TikTok views when 1.167.605 did —
// eighty-six times the truth, in the flattering direction. Fifteen of the
// sightings were from July.
//
// An event has a period by definition. Attribution therefore starts with the
// period and only then asks who posted it.
//
// WHY ATTRIBUTION IS DERIVED AND NOT STAMPED. No eventId is written onto post
// documents. Everything matchEvent needs — a timestamp, a handle, a hashtag
// list — is already on every row, so deriving costs one pass over data we hold
// and needs no deploy, no backfill, and no migration when a window moves. If it
// ever gets slow, stamping is purely additive.

import type { Source } from './campaign'
import { EVENTS, type StelzEvent, type EventRosterMember } from '../data/events'

export type EventMatch = {
  eventId: string
  source: Source
  /** The hashtag that surfaced a discovery item; null for roster content,
   *  which was found by handle rather than by tag. */
  foundVia: string | null
}

/** The shape matchEvent needs. Deliberately narrower than CampaignItem so the
 *  Python-side archive rows and the client rows can both be passed in. */
export type Attributable = {
  postedAt?: string | null
  /** The person, after identity mapping. */
  creatorHandle?: string | null
  /** The account it was actually posted from. */
  platformHandle?: string | null
  /** Whose profile the scraper was reading when it found this. A collab post
   *  appears on both authors' profiles; Apify records the one it asked for. */
  scrapedFor?: string | null
  hashtags?: string[] | null
  /** The tag whose search returned this row, recorded by the harvest.
   *
   *  Stronger evidence than `hashtags`, and needed because they disagree far
   *  more often than you would expect: 82 of 176 archived discovery rows carry
   *  no event tag in their caption at all. Some of those are TikTok's search
   *  being fuzzy — a hotel in Tobago under #lowlandstobago, a country singer
   *  called @lowland2026, a hair salon called Stelz — and some are genuine
   *  festival content whose caption simply did not repeat the tag. Trusting
   *  only the caption drops both kinds; trusting the recorded search keeps
   *  both. Keeping them is the right error: they enter the DENOMINATOR, and a
   *  denominator that is too large understates the hit rate. */
  foundVia?: string | null
}

const clean = (h: string | null | undefined): string =>
  (h ?? '').trim().replace(/^@/, '').toLowerCase()

/** The full period an item can belong to: the event plus its run-up and tail.
 *
 *  Both bounds inclusive, both 'YYYY-MM-DD'. Not Date objects — every date
 *  comparison in this codebase is already lexicographic on ISO text, and a
 *  festival day is a calendar day with no timezone of its own. */
export function eventWindow(ev: StelzEvent): { start: string; end: string } {
  const d = derived(ev)
  if (d.window) return d.window
  d.window = {
    start: shiftDays(ev.window.start, -(ev.window.preDays ?? 0)),
    end: shiftDays(ev.window.end, ev.window.postDays ?? 0),
  }
  return d.window
}

/** UTC day bounds for a window, for a range query against stored timestamps.
 *
 *  `inWindow` above compares the ISO date PREFIX of postedAt, and that prefix is
 *  UTC. So a fetch that selects rows by timestamp has to use UTC bounds too, or
 *  the two rules disagree by up to two hours at each edge — the fetch drags in
 *  posts the page then silently discards, and drops posts it would have kept. */
export function dayBounds(range: { start: string; end: string }): [Date, Date] {
  return [
    new Date(`${range.start}T00:00:00.000Z`),
    new Date(`${range.end}T23:59:59.999Z`),
  ]
}

/** Human-readable window, e.g. "17 – 30 aug". */
export function formatWindow(ev: StelzEvent): string {
  const { start, end } = eventWindow(ev)
  const d = (iso: string) => Number(iso.slice(8, 10))
  const m = (iso: string) =>
    ['jan', 'feb', 'mrt', 'apr', 'mei', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'][
      Number(iso.slice(5, 7)) - 1
    ] ?? ''
  return m(start) === m(end)
    ? `${d(start)} – ${d(end)} ${m(end)}`
    : `${d(start)} ${m(start)} – ${d(end)} ${m(end)}`
}

/** Is this timestamp inside the event's period?
 *
 *  Date part only. A post at 23:50 on the last day is in; converting the
 *  platform's timezone is not worth it when the boundary already carries seven
 *  days of slack on one side and three on the other. */
export function inWindow(ev: StelzEvent, postedAt: string | null | undefined): boolean {
  if (!postedAt) return false
  const { start, end } = eventWindow(ev)
  const day = String(postedAt).slice(0, 10)
  return day >= start && day <= end
}

/** Where the event stands relative to a given day (defaults to today). */
export function eventStatus(ev: StelzEvent, today?: string): 'aankomend' | 'live' | 'afgelopen' {
  const day = (today ?? new Date().toISOString()).slice(0, 10)
  if (day < ev.window.start) return 'aankomend'
  if (day > ev.window.end) return 'afgelopen'
  return 'live'
}

/** Every handle on the roster, both platforms, as one set. */
// Per-event memo for the three derived structures below. Event definitions are
// static JSON imports with stable identities, and matchEvent runs in loops
// over thousands of rows — rebuilding a Set and two arrays per ROW measured
// 15–29 ms per pass over the 4.5K-row fixture, several passes per page.
const derivedCache = new WeakMap<StelzEvent, {
  roster?: Set<string>
  tags?: string[]
  window?: { start: string; end: string }
}>()

function derived(ev: StelzEvent) {
  let d = derivedCache.get(ev)
  if (!d) {
    d = {}
    derivedCache.set(ev, d)
  }
  return d
}

export function rosterAccounts(ev: StelzEvent): Set<string> {
  const d = derived(ev)
  if (d.roster) return d.roster
  const out = new Set<string>()
  for (const m of ev.roster) {
    const ig = clean(m.instagram)
    const tt = clean(m.tiktok)
    if (ig) out.add(ig)
    if (tt) out.add(tt)
  }
  d.roster = out
  return out
}

/**
 * Was this account booked for anything, and by whom?
 *
 * The question a creator page has to answer before it can say anything useful
 * about an empty result. "No detections for @davidscholten" and "@davidscholten
 * was booked for Lowlands and posted nothing" are the same absence of data and
 * opposite findings — the first reads as a gap in the tool, the second is the
 * single most valuable line a paid roster produces.
 *
 * Matches on either platform, because the roster books a PERSON and Instagram
 * and TikTok handles rarely agree.
 */
export function bookingFor(handle: string, events: StelzEvent[] = EVENTS):
  { event: StelzEvent; member: EventRosterMember } | null {
  const want = clean(handle)
  if (!want) return null
  return events.flatMap((event) => event.roster
    .filter((m) => clean(m.instagram) === want || clean(m.tiktok) === want)
    .map((member) => ({ event, member })))[0] ?? null
}

/** TikTok handle -> that person's Instagram handle.
 *
 *  Instagram wins because creator ids and project rosters are already built
 *  from it (splitCreatorId in lib/projects.ts). Without this Rein counts twice
 *  and a roster of 28 reports 42 creators. */
export function identityMap(ev: StelzEvent): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of ev.roster) {
    const ig = clean(m.instagram)
    const tt = clean(m.tiktok)
    if (ig && tt) out.set(tt, ig)
  }
  return out
}

/** Any handle, either platform -> the person's name. */
export function nameMap(ev: StelzEvent): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of ev.roster) {
    if (!m.name) continue
    for (const h of [clean(m.instagram), clean(m.tiktok)]) if (h) out.set(h, m.name)
  }
  return out
}

/** The event's tags, brand family first.
 *
 *  Order matters for attribution, not for scraping: it decides which tag gets
 *  the credit when a post carries several. #stelzlowlands says far more about
 *  why the post was found than #lowlands does, so the specific one wins. */
export function orderedTags(ev: StelzEvent): string[] {
  const d = derived(ev)
  if (d.tags) return d.tags
  const norm = (t: string) => t.replace(/^#/, '').toLowerCase()
  d.tags = [
    ...ev.hashtags.filter((h) => h.family === 'brand').map((h) => norm(h.tag)),
    ...ev.hashtags.filter((h) => h.family !== 'brand').map((h) => norm(h.tag)),
  ]
  return d.tags
}

/** The roster in the paste format the import screen parses.
 *
 *  PasteImport takes text, so the UI needs a TSV. Built from the definition
 *  rather than stored beside it — two hand-maintained copies of one roster is
 *  what data/lowlandsSeed.ts was, and it drifted from the scrapers by design.
 *  "Geen" comes back for the null TikToks because that is the word the client's
 *  sheet uses and parseCreatorList already knows to skip it. */
export function seedTsv(ev: StelzEvent): string {
  return [
    'Gasten\tTag Instagram\tTag TikTok',
    ...ev.roster.map((m) => `${m.name}\t${m.instagram}\t${m.tiktok || 'Geen'}`),
  ].join('\n')
}

/** Does this item belong to this event, and as roster or as discovery?
 *
 *  The order is the whole design:
 *
 *   1. WINDOW FIRST. Outside the period nothing else is asked. This is the rule
 *      that stops last year's #lowlands from being counted as this year's
 *      organic pickup — always in the flattering direction, which is exactly
 *      why it has to be first.
 *   2. scraped_for on the roster -> ROSTER. A collab post is published from a
 *      co-author's account: golfnl's post was found on Britt Messing's profile
 *      because she is on it. 44 rows across 15 non-roster accounts look like
 *      strangers and are not — all 45 raw payloads resolve back to a roster
 *      handle through Apify's inputUrl. Dropping them to discovery would move
 *      bought reach into the organic column.
 *   3. Either handle on the roster -> ROSTER. Both columns, because the same
 *      person's TikTok and Instagram names differ.
 *   4. A matching hashtag -> DISCOVERY, credited to the most specific tag that
 *      matched.
 *   5. ACCOUNT EVIDENCE, last: a dated in-window post from a handle in
 *      `evidencedHandles` -> DISCOVERY, foundVia 'profiel'. The set holds
 *      accounts that proved their presence elsewhere — another in-window post
 *      of theirs carries a matching tag. A festival-goer tags #lowlands on one
 *      clip and not on the other four from the same campsite; the tagged one
 *      proves the weekend, the untagged ones ride on that proof. Last, because
 *      a tag on the post itself is stronger evidence and should win the
 *      foundVia. The default is an empty set, so a caller that passes nothing
 *      gets the exact pre-existing behaviour — and the window rule still runs
 *      FIRST: evidence cannot pull last year's content in.
 *   6. Otherwise: not this event.
 *
 *  Without a timestamp a roster post still matches (rule 3 does not consult the
 *  date) but a hashtag find does not — and neither does account evidence.
 *  Asymmetric on purpose: a roster creator's undated post is at worst filed
 *  under the wrong event of theirs, while an undated hashtag hit is an
 *  unbounded invitation for old festival content to inflate the organic
 *  number. */
export function matchEvent(
  ev: StelzEvent, item: Attributable,
  evidencedHandles: ReadonlySet<string> = EMPTY_EVIDENCE,
): EventMatch | null {
  const roster = rosterAccounts(ev)
  const onRoster =
    roster.has(clean(item.scrapedFor)) ||
    roster.has(clean(item.creatorHandle)) ||
    roster.has(clean(item.platformHandle))

  const dated = item.postedAt != null && item.postedAt !== ''
  if (dated && !inWindow(ev, item.postedAt)) return null

  if (onRoster) return { eventId: ev.id, source: 'roster', foundVia: null }
  if (!dated) return null

  const ordered = orderedTags(ev)
  // What the harvest actually searched for, first. See Attributable.foundVia.
  const recorded = (item.foundVia ?? '').replace(/^#/, '').toLowerCase()
  if (recorded && ordered.includes(recorded)) {
    return { eventId: ev.id, source: 'discovery', foundVia: recorded }
  }
  const tags = new Set((item.hashtags ?? []).map((t) => t.replace(/^#/, '').toLowerCase()))
  const hit = ordered.find((t) => tags.has(t))
  if (hit) return { eventId: ev.id, source: 'discovery', foundVia: hit }

  // Account evidence, LAST. A tag on the post itself is stronger and more
  // specific, so it wins the foundVia; this rule only catches the untagged
  // remainder of an account that proved its weekend elsewhere.
  if (evidencedHandles.size > 0) {
    const account = clean(item.platformHandle) || clean(item.creatorHandle)
    if (account && evidencedHandles.has(account)) {
      return { eventId: ev.id, source: 'discovery', foundVia: 'profiel' }
    }
  }
  return null
}

/** Shared frozen default so the no-evidence call path allocates nothing. */
const EMPTY_EVIDENCE: ReadonlySet<string> = new Set()

/**
 * The handles whose presence at this event is PROVEN: non-roster accounts with
 * at least one dated in-window item carrying a matching tag (in the caption or
 * as the recorded search tag). Feed the result back into matchEvent as
 * `evidencedHandles` and the same account's untagged in-window posts count too.
 *
 * Built from the full row set in one pass, here rather than in a component, so
 * the rule that GRANTS evidence and the rule that SPENDS it live in one file
 * and cannot drift apart.
 */
export function evidencedHandlesFor(ev: StelzEvent, items: Attributable[]): Set<string> {
  const roster = rosterAccounts(ev)
  const ordered = orderedTags(ev)
  const out = new Set<string>()
  for (const item of items) {
    const account = clean(item.platformHandle) || clean(item.creatorHandle)
    if (!account || roster.has(account) || out.has(account)) continue
    if (!item.postedAt || !inWindow(ev, item.postedAt)) continue
    const recorded = (item.foundVia ?? '').replace(/^#/, '').toLowerCase()
    // 'profiel' is what rule 4 WRITES, never evidence for it — otherwise one
    // pass's output becomes the next pass's proof and the set only grows.
    if (recorded === 'profiel') continue
    if (recorded && ordered.includes(recorded)) { out.add(account); continue }
    const tags = (item.hashtags ?? []).map((t) => t.replace(/^#/, '').toLowerCase())
    if (tags.some((t) => ordered.includes(t))) out.add(account)
  }
  return out
}

function shiftDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
