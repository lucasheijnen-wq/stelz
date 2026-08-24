// The hits table: every sighting of Stëlz on one row, with the numbers its
// platform actually publishes.
//
// WHY THIS FILE EXISTS SEPARATELY FROM campaign.ts. That file answers "how did
// the campaign do" — totals, per creator, per surface. This one answers a
// narrower question a brand asks in a meeting: show me the list, and let me
// sort it by whatever I care about right now.
//
// THE THING THIS FILE IS MOSTLY ABOUT IS THE EMPTY CELLS. Of 63 sightings at
// Lowlands, 22 were Instagram stories, and Instagram publishes a story's view
// count to the account holder and to nobody else. Two of 16 Instagram posts
// report plays, because a photo post has none — only a reel does. So a third of
// this table is blank by nature, and the blanks are the part most likely to be
// misread.
//
// A zero would be a lie: it says "nobody watched". A blank with an explanation
// is the truth: "this platform does not tell us". Hence `publishedBy` on every
// metric column, `hitValue` returning null rather than 0, and a sort that keeps
// nulls at the bottom in BOTH directions — sorting by views ascending must not
// put 22 unmeasurable stories above the video that got 194.300 plays.

import { PRODUCT_LINE_LABEL } from './labels'
import { SOURCE_LABEL, SURFACE_LABEL, type CampaignRow, type Surface } from './campaign'
import { isStelzStory } from './storyStats'
import { fmtDate, fmtNum } from './format'

export type HitColumnKey =
  | 'postedAt' | 'handle' | 'source' | 'surface' | 'slide'
  | 'views' | 'likes' | 'comments' | 'shares' | 'saves' | 'followers'
  | 'product' | 'placement' | 'visibility' | 'foundVia'

export type HitColumn = {
  key: HitColumnKey
  label: string
  /** Right-aligned and compared as numbers. */
  numeric: boolean
  /** Which surfaces publish this figure. Absent means it is not a platform
   *  metric at all (a date, a handle, our own verdict) and so cannot be
   *  "missing" — only a metric column can have an honest blank. */
  publishedBy?: Surface[]
  /** Drop the column when it is blank for every row in view. Implied by
   *  `numeric`; set it on a text column that is genuinely absent rather than
   *  unknown — "Dia" on a selection with no carousel in it. */
  hideWhenEmpty?: boolean
  /** Column header tooltip. */
  title?: string
}

/** The columns, in table order. This one array drives the headers, the sort,
 *  the legend under the table and the CSV export, so those four cannot drift
 *  apart — which is the usual way an export ends up disagreeing with a screen. */
export const HIT_COLUMNS: HitColumn[] = [
  { key: 'postedAt', label: 'Datum', numeric: false },
  { key: 'handle', label: 'Account', numeric: false },
  { key: 'source', label: 'Bron', numeric: false,
    title: 'Roster = geboekt en betaald. Los gevonden = kwam er vanzelf.' },
  { key: 'surface', label: 'Vlak', numeric: false },
  // WITHOUT THIS COLUMN THE EXPORT LIES BY OMISSION. One row per sighting means
  // a carousel appears five times, each row repeating the post's 2.179 likes,
  // and nothing on the sheet says they are one post — so summing the Likes
  // column in Excel reproduces exactly the 147% overstatement the totals had.
  // "3/10" says which slide; blank means the row is the whole post.
  { key: 'slide', label: 'Dia', numeric: false, hideWhenEmpty: true,
    title: 'Een carrousel wordt per dia beoordeeld. Rijen met dezelfde dia-reeks zijn één post en delen dus één keer likes en reacties — tel ze niet bij elkaar op.' },
  { key: 'views', label: 'Weergaven', numeric: true, publishedBy: ['tiktok', 'post'],
    title: 'TikTok publiceert afspeeltellingen. Op Instagram alleen een reel, nooit een fotopost of een story.' },
  { key: 'likes', label: 'Likes', numeric: true, publishedBy: ['tiktok', 'post'],
    title: 'Instagram-posts en TikToks. Een story heeft geen zichtbare likes.' },
  { key: 'comments', label: 'Reacties', numeric: true, publishedBy: ['tiktok', 'post'] },
  { key: 'shares', label: 'Delen', numeric: true, publishedBy: ['tiktok'],
    title: 'Alleen TikTok publiceert dit.' },
  { key: 'saves', label: 'Opgeslagen', numeric: true, publishedBy: ['tiktok'],
    title: 'Bewaard om later terug te kijken. Alleen TikTok publiceert dit, en het zegt meer dan een like.' },
  { key: 'followers', label: 'Volgers', numeric: true,
    title: 'Van het account op het moment van scrapen. Niet iedereen geeft het prijs.' },
  { key: 'product', label: 'Product', numeric: false },
  { key: 'placement', label: 'Plaatsing', numeric: false,
    title: 'Waar het merk stond als het niet op een blikje was — een bord, merch, kleding.' },
  { key: 'visibility', label: 'Zichtbaar', numeric: false,
    title: 'Goed = onmiskenbaar in beeld. Klein = echt aanwezig, maar klein of deels afgedekt.' },
  { key: 'foundVia', label: 'Gevonden via', numeric: false,
    title: 'De hashtag die dit bovenbracht. Roster-content is op account gevonden en heeft er geen.' },
]

const PLACEMENT_TEXT: Record<string, string> = {
  signage: 'bord',
  merchandise: 'merch',
  clothing: 'kleding',
  other: 'anders',
}

/** Only the sightings. A tile without the can is counted in the denominator
 *  above the table, but it is not a row anybody scrolls through. */
export function stelzHits(rows: CampaignRow[]): CampaignRow[] {
  return rows.filter((r) => isStelzStory(r.verdict))
}

/**
 * The sortable value, or null when this surface publishes no such number.
 *
 * Null and 0 are kept strictly apart. TikTok genuinely reports 0 shares on some
 * videos and that is a measurement; a story's view count is not zero, it is
 * unknown, and the two must never sort or export as the same thing.
 */
export function hitValue(r: CampaignRow, key: HitColumnKey): string | number | null {
  switch (key) {
    case 'postedAt': return r.postedAt ?? null
    case 'handle': return (r.platformHandle || r.creatorHandle || '').toLowerCase() || null
    case 'source': return SOURCE_LABEL[r.source]
    case 'surface': return SURFACE_LABEL[r.surface]
    // Blank for anything that is not a carousel — a TikTok has no slides, and
    // "1/1" would suggest it might have. `slot` is 0-based in the archive.
    case 'slide': return r.slots != null && r.slots > 1 && r.slot != null
      ? `${r.slot + 1}/${r.slots}` : null
    case 'views': return r.views ?? null
    case 'likes': return r.likes ?? null
    case 'comments': return r.comments ?? null
    case 'shares': return r.shares ?? null
    case 'saves': return r.saves ?? null
    case 'followers': return r.detection?.follower_count ?? null
    case 'product': return r.detection?.product_line ?? null
    case 'placement': return r.placement ?? null
    // Our own reading, not the platform's — so it is never blank on a hit.
    case 'visibility': return r.verdict === 'visible' ? 'goed' : 'klein'
    case 'foundVia': return r.foundVia ?? null
  }
}

/** What the cell says. Used by the table and by the CSV, so the file a client
 *  opens and the screen they were shown carry the same words. */
export function hitText(r: CampaignRow, key: HitColumnKey): string {
  const v = hitValue(r, key)
  if (v == null) return '—'
  switch (key) {
    case 'postedAt': return fmtDate(String(v))
    case 'handle': return `@${v}`
    case 'product': return PRODUCT_LINE_LABEL[String(v)] ?? String(v)
    case 'placement': return PLACEMENT_TEXT[String(v)] ?? String(v)
    case 'foundVia': return `#${v}`
    default: return typeof v === 'number' ? fmtNum(v) : String(v)
  }
}

/**
 * Sort by one column.
 *
 * NULLS STAY LAST IN BOTH DIRECTIONS. The alternative — treating a blank as
 * -Infinity — means clicking "Weergaven" ascending fills the top of the table
 * with the 22 stories nobody can measure, which reads as "these performed
 * worst" when what it means is "these were never counted".
 *
 * Ties break on date then id, so the order is the same on every machine rather
 * than depending on the input order.
 */
export function sortHits(rows: CampaignRow[], key: HitColumnKey, dir: 'asc' | 'desc'): CampaignRow[] {
  const sign = dir === 'asc' ? 1 : -1
  return [...rows].sort((a, b) => {
    const av = hitValue(a, key)
    const bv = hitValue(b, key)
    if (av == null && bv != null) return 1
    if (bv == null && av != null) return -1
    if (av != null && bv != null) {
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av).localeCompare(String(bv), 'nl')
      if (cmp !== 0) return cmp * sign
    }
    return (b.postedAt ?? '').localeCompare(a.postedAt ?? '')
      || a.itemId.localeCompare(b.itemId)
  })
}

/** One sentence per surface about what it does and does not publish, built
 *  from HIT_COLUMNS so it cannot describe a column that no longer exists. */
export function metricLegend(): { surface: Surface; has: string[]; missing: string[] }[] {
  const metrics = HIT_COLUMNS.filter((c) => c.publishedBy)
  return (['tiktok', 'post', 'story'] as Surface[]).map((surface) => ({
    surface,
    has: metrics.filter((c) => c.publishedBy!.includes(surface)).map((c) => c.label.toLowerCase()),
    missing: metrics.filter((c) => !c.publishedBy!.includes(surface)).map((c) => c.label.toLowerCase()),
  }))
}

/**
 * Day buckets across a fixed range, rather than the last N days from today.
 *
 * Chart.bucketByDay counts backwards from the current date, which is right for
 * a live feed and wrong for an event: open Lowlands in October and every bucket
 * is empty, because the festival fell outside the window the chart drew. An
 * event has a period written down, so the chart uses that period.
 */
export function bucketByRange(
  timestamps: (string | null | undefined)[], start: string, end: string,
): { d: string; n: number }[] {
  const buckets = new Map<string, number>()
  for (let d = new Date(`${start}T00:00:00Z`); d <= new Date(`${end}T00:00:00Z`);
       d.setUTCDate(d.getUTCDate() + 1)) {
    buckets.set(d.toISOString().slice(0, 10), 0)
  }
  for (const t of timestamps) {
    const key = (t ?? '').slice(0, 10)
    if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1)
  }
  return [...buckets.entries()].map(([d, n]) => ({ d, n }))
}

export type HitTotals = {
  /** SIGHTINGS: how many times the can was seen. Three slides of one carousel
   *  are three sightings — and one post. Only this field counts them that way;
   *  every metric below is per post. */
  hits: number
  /** Sightings deduped to posts: a carousel where the can is on slides 3 and 7
   *  is one post, not two. */
  posts: number
  accounts: number
  /** Plays on the videos Stëlz was actually visible in — not on everything the
   *  roster posted. This tab answers "what did Stëlz get", so the denominator
   *  is the posts, and `tiktokVideos` says how many carried the figure. */
  tiktokViews: number
  tiktokVideos: number
  postLikes: number
  likedPosts: number
  /** Stories among the sightings, as posts. Named because it is the count with
   *  no audience figure attached, and that has to be visible rather than absent. */
  storyHits: number
  /**
   * The six header figures: the same event summed across platforms.
   *
   * A TikTok play and an Instagram reel play are one event on two platforms, as
   * are a digg and a like — those add. What never happens is a figure combining
   * plays with likes, which is the "total reach" this codebase had to unpick
   * once already (100.928.763 reported where 1.167.605 was true).
   *
   * PER POST, NOT PER SIGHTING, and that distinction cost 10.161 likes the
   * first time it was got wrong. A post's like count belongs to the post: when
   * the can shows up on five slides of @sterredegoedex's carousel, that is five
   * sightings of one post with 2.179 likes — not 10.895 likes. Summing the rows
   * reported 48.919 where 38.758 was true, a 26% overstatement on a headline
   * figure. Every metric here is therefore reduced over unique `postKey`.
   *
   * Each total ships with the number of POSTS that carried it. 844.643 views
   * across 27 of 58 posts is a different claim from 844.643 across all 58, and
   * printing the total without the count makes the second one.
   */
  views: number
  viewedOn: number
  likes: number
  likedOn: number
  comments: number
  commentedOn: number
  shares: number
  sharedOn: number
  /** Saves. TikTok only, and the strongest intent signal it publishes. */
  saves: number
  savedOn: number
  /** Likes + comments + shares against plays, TikTok only — the one surface
   *  that reports both halves of the ratio. Null when nothing was played. */
  engagementRate: number | null
  tiktokInteractions: number
  /**
   * Followers of the TIKTOK accounts behind these sightings.
   *
   * TikTok only, and named that way, because that is all there is: of 2.693
   * detections on the Lowlands fixture, 1.159 carry a follower count and every
   * single one of them sits on a TikTok row. Instagram's scrape returns none at
   * all. A field called `followers` would therefore be a TikTok figure wearing
   * a campaign-wide label on a campaign that is two-thirds Instagram.
   *
   * Never called reach either: it is the size of an audience that COULD have
   * seen this, not a count of anyone who did.
   */
  tiktokFollowers: number
  tiktokFollowersKnownFor: number
  tiktokAccounts: number
  tiktokAccountsWithoutFollowers: string[]
}

/** The account a row is credited to for counting purposes. */
const accountOf = (r: CampaignRow) => (r.platformHandle || r.creatorHandle || '').toLowerCase()

/**
 * Biggest follower count seen per account, across EVERY row — not just the
 * sightings.
 *
 * A creator's follower count does not depend on which of their posts you happen
 * to be looking at, but whether the scrape reported one does: of 108 detections
 * on Lowlands sightings only 37 carry a number, while the same 42 accounts have
 * one somewhere in their other 2.500 rows. Reading it off the hits alone put
 * @lizebooij, @pleunbierbooms and seventeen others in the "unknown" column and
 * understated the audience by two thirds.
 *
 * Keyed on the posting account rather than the credited creator: on a collab
 * post the two differ, and handing the co-author's follower count to the booked
 * creator would inflate exactly the number this file is careful about.
 */
export function followerIndex(rows: CampaignRow[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of rows) {
    const n = r.detection?.follower_count
    const key = accountOf(r)
    if (n == null || !key) continue
    out.set(key, Math.max(out.get(key) ?? 0, n))
  }
  return out
}

/**
 * The headline figures, from the sightings alone.
 *
 * NOTHING HERE ADDS TWO SURFACES TOGETHER. A TikTok play, an Instagram like and
 * a story are three different events; the one number that would look best on a
 * slide — all of them summed — is the one number that means nothing. Each field
 * names the surface it came from and the count it was drawn from.
 *
 * @param followers where to look up an account's audience. Pass the index built
 *   from the FULL row set; the default falls back to the hits themselves, which
 *   is correct but finds far fewer counts.
 */
export function hitTotals(
  hits: CampaignRow[], followers: Map<string, number> = followerIndex(hits),
): HitTotals {
  // ONE ROW PER POST BEFORE ANY METRIC IS ADDED. The rows are sightings, and a
  // carousel produces one per slide the can appears on — each carrying the same
  // post-level like count, because that is the only like count the post has.
  // Adding them row by row charged @sterredegoedex's 2.179 likes five times.
  // The first row wins; they are identical on the fields summed here.
  const byPost = new Map<string, CampaignRow>()
  const accounts = new Set<string>()
  for (const r of hits) {
    accounts.add(accountOf(r))
    if (!byPost.has(r.postKey)) byPost.set(r.postKey, r)
  }

  const ttAccounts = new Set<string>()
  let tiktokViews = 0, tiktokVideos = 0, postLikes = 0, likedPosts = 0, storyHits = 0
  let views = 0, viewedOn = 0, likes = 0, likedOn = 0
  let comments = 0, commentedOn = 0, shares = 0, sharedOn = 0, saves = 0, savedOn = 0
  let ttInteractions = 0

  for (const r of byPost.values()) {
    // Cross-platform, same event. Null is skipped rather than added as 0, so a
    // surface that publishes nothing lowers neither the total nor the count.
    if (r.views != null) { views += r.views; viewedOn += 1 }
    if (r.likes != null) { likes += r.likes; likedOn += 1 }
    if (r.comments != null) { comments += r.comments; commentedOn += 1 }
    if (r.shares != null) { shares += r.shares; sharedOn += 1 }
    if (r.saves != null) { saves += r.saves; savedOn += 1 }
    if (r.surface === 'tiktok') {
      ttAccounts.add(accountOf(r))
      if (r.views != null) { tiktokViews += r.views; tiktokVideos += 1 }
      ttInteractions += (r.likes ?? 0) + (r.comments ?? 0) + (r.shares ?? 0)
    }
    if (r.surface === 'post' && r.likes != null) { postLikes += r.likes; likedPosts += 1 }
    if (r.surface === 'story') storyHits += 1
  }

  const known = [...ttAccounts].filter((h) => followers.get(h) != null)
  return {
    hits: hits.length,
    posts: byPost.size,
    accounts: accounts.size,
    views, viewedOn, likes, likedOn, comments, commentedOn,
    shares, sharedOn, saves, savedOn,
    tiktokInteractions: ttInteractions,
    engagementRate: tiktokViews > 0 ? (ttInteractions / tiktokViews) * 100 : null,
    tiktokViews, tiktokVideos, postLikes, likedPosts, storyHits,
    tiktokFollowers: known.reduce((s, h) => s + (followers.get(h) ?? 0), 0),
    tiktokFollowersKnownFor: known.length,
    tiktokAccounts: ttAccounts.size,
    tiktokAccountsWithoutFollowers: [...ttAccounts].filter((h) => followers.get(h) == null).sort(),
  }
}

/**
 * One representative sighting per POST, for a grid of tiles.
 *
 * The rows are sightings, and a carousel with the can on eight slides is eight
 * of them. A grid that draws every sighting shows the same post eight times
 * over — which reads as duplicated data, not as thoroughness. The best sighting
 * fronts the post ('visible' beats 'small', then confidence, then slide order
 * so the choice is stable), and `moreSlides` says how many were folded in so
 * the card can wear it as a badge instead of hiding it. Newest first, because
 * every grid that renders this sorts that way.
 *
 * The Cijfers table deliberately does NOT use this: there the per-sighting rows
 * are the point, and its Dia column is what keeps them legible.
 */
export function groupHitsByPost(
  hits: CampaignRow[],
): { row: CampaignRow; moreSlides: number }[] {
  const rank = (r: CampaignRow) =>
    (r.verdict === 'visible' ? 0 : 1) * 1000 - (r.confidence ?? 0)
  const byPost = new Map<string, { row: CampaignRow; moreSlides: number }>()
  for (const r of hits) {
    const cur = byPost.get(r.postKey)
    if (!cur) byPost.set(r.postKey, { row: r, moreSlides: 0 })
    else {
      cur.moreSlides += 1
      if (rank(r) < rank(cur.row)
        || (rank(r) === rank(cur.row) && (r.slot ?? 0) < (cur.row.slot ?? 0))) {
        cur.row = r
      }
    }
  }
  return [...byPost.values()].sort(
    (a, b) => (b.row.postedAt ?? '').localeCompare(a.row.postedAt ?? '')
      || a.row.itemId.localeCompare(b.row.itemId))
}

/** Which metric columns hold at least one real number in this set.
 *
 *  A column that is empty for every row in view is worse than useless: it
 *  occupies width and invites the reader to conclude the campaign scored zero
 *  there. Filtering on a story-only selection should drop "Delen", not print
 *  22 dashes under it. */
export function liveColumns(rows: CampaignRow[]): HitColumn[] {
  return HIT_COLUMNS.filter((c) => {
    if (!c.numeric && !c.hideWhenEmpty) return true
    return rows.some((r) => hitValue(r, c.key) != null)
  })
}
