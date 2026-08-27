// The campaign across both platforms: what each creator posted, where, and
// where Stëlz was actually in frame.
//
// WHY THIS IS SEPARATE FROM storyStats.ts. Stories are one surface with one
// honest metric (poll votes). A campaign spans three surfaces that do not share
// a single number between them:
//
//   * IG story   — no view count exists at all; poll votes are the only floor.
//   * IG post    — likes and comments; a reel also reports plays, a photo does not.
//   * TikTok     — playCount, published. The FIRST real viewing figure anywhere
//                  in this product, and worth naming as such.
//
// THE RULE THAT MATTERS: metrics are never summed across surfaces. A TikTok
// play and a poll vote are not the same event, and adding them produces a
// "total reach" that means nothing while looking authoritative — which is
// exactly how these numbers become fiction in a deck. Every total here is
// per-surface, and the type makes the other thing hard to write by accident.

import type { DetectionRow } from './types'
import type { CreatorProfile } from './firestore'
import {
  isNearMiss, isStelzStory, VERDICT_LABEL, type StoryVerdict,
} from './storyStats'
import { detectionQuality } from './quality'

export { VERDICT_LABEL }

export type Surface = 'story' | 'post' | 'tiktok'

/** Who posted it, and therefore what it proves.
 *
 *  `roster`    — one of the creators Stëlz is paying. Answers a CONTRACT
 *                question: did the people we booked deliver?
 *  `discovery` — anyone else at the same festival, found by hashtag. Answers a
 *                MARKETING question: is the can showing up on its own?
 *
 *  Never merged into one total. Paid delivery and organic pickup are worth
 *  different things, and a single "reach" number that contains both flatters
 *  the campaign by counting strangers as deliverables. */
export type Source = 'roster' | 'discovery'

export const SOURCE_LABEL: Record<Source, string> = {
  roster: 'Roster',
  discovery: 'Los gevonden',
}

/** A stored post's surface — derived, because only SOME rows carry the field.
 *
 *  The imported event rows (78_upload_event.py) write `surface` outright. The
 *  live scanners never do: scan_creators, scan_hashtags and scan_stories predate
 *  the event layer and write `contentType` and `platform` instead. Defaulting
 *  the missing field to 'post' files every scanned TikTok as an Instagram post
 *  and every scanned story as one too — the TikTok KPI then reads zero while the
 *  IG-post grid fills up with clips.
 *
 *  Takes a plain record rather than a Firestore DocumentData so this file stays
 *  free of the SDK and testable without it. */
export function surfaceOf(x: Record<string, unknown>): Surface {
  const named = x.surface
  if (named === 'story' || named === 'post' || named === 'tiktok') return named
  if (x.contentType === 'story') return 'story'
  if (x.platform === 'tiktok') return 'tiktok'
  return 'post'
}

export const SURFACE_LABEL: Record<Surface, string> = {
  story: 'IG story',
  post: 'IG post',
  tiktok: 'TikTok',
}

/** What each surface actually publishes. Rendered next to every number so a
 *  reader never has to guess whether "12k" means people or taps. */
export const SURFACE_METRIC: Record<Surface, string> = {
  story: 'poll-stemmen (ondergrens kijkers)',
  post: 'likes',
  tiktok: 'weergaven',
}

/** One piece of content, before the verdict is attached. Mirrors what the
 *  archives and (after deploy) the posts collection hold. */
export type CampaignItem = {
  itemId: string
  platform: 'instagram' | 'tiktok'
  surface: Surface
  /** The PERSON. Rein is @rvdofficial on Instagram and @rinnavandoffoe on
   *  TikTok; keyed on the account he shows up as two creators and the roster
   *  of 28 reports 42, which makes "who delivered nothing" unanswerable. */
  creatorHandle: string
  /** The account it was actually posted from, kept for the link and the label. */
  platformHandle?: string
  url: string | null
  coverUrl: string | null
  videoUrl: string | null
  mediaType: 'image' | 'video'
  postedAt: string | null
  caption: string | null
  hashtags: string[]
  mentions: string[]
  videoDuration: number | null
  /** TikTok playCount, or an IG reel's plays. Null where the surface has no
   *  such number — never 0, which would read as "nobody watched". */
  views: number | null
  likes: number | null
  comments: number | null
  shares: number | null
  /** Saves. TikTok's strongest intent signal — a like costs nothing, a save
   *  means "I want this back". Instagram publishes no equivalent, so it is null
   *  there rather than 0. */
  saves: number | null
  pollVotes: number | null
  isPaidPartnership: boolean
  /** Defaults to 'roster' when absent: every archive that predates discovery
   *  is roster content, and guessing 'discovery' would invent organic reach. */
  source?: Source
  /** The hashtag that surfaced a discovery item. Null for roster content,
   *  which was found by handle. Kept so a tag's real yield can be measured
   *  rather than assumed. */
  foundVia?: string | null
  /** Which event's harvest produced this row. Provenance, not attribution —
   *  whether a row BELONGS to an event is decided by lib/events.matchEvent,
   *  which reads the date, the roster and the tags. */
  eventId?: string | null
  /** Whose profile the scraper was reading when it found this. On a collab post
   *  it is the only link back to the roster: Instagram publishes the post on
   *  both authors' profiles, so `platformHandle` is the co-author's account.
   *  44 rows across 15 accounts read as strangers without it. */
  scrapedFor?: string | null
  /** What makes several rows ONE post. A carousel is archived per slide — the
   *  can is rarely on slide one — so 37 sightings can be 18 posts, and both
   *  numbers are worth having as long as neither is labelled the other. */
  postKey?: string | null
  /** Position in a carousel, and how many slides it has. Null off Instagram. */
  slot?: number | null
  slots?: number | null
}

export type CampaignRow = CampaignItem & {
  verdict: StoryVerdict
  detection: DetectionRow | null
  confidence: number | null
  framesJudged: number
  /** The clip was never obtained; only its cover was judged. */
  coverOnly: boolean
  /** Where the wordmark was, when it was NOT on a can — a bar front, a parasol,
   *  a branded tray, a cap. Null for an ordinary can sighting. Kept as its own
   *  field rather than folded into the verdict: "someone drank one" and "the
   *  bar carried our logo" are different things to have bought. */
  placement: DetectionRow['verify_placement']
  /** Always set, unlike the optional field on the item. */
  source: Source
  /** True when this sighting would NOT survive the deployed backend's 512px
   *  downscale. Not a doubt about the photo — a gap between what was measured
   *  here and what the live function currently sees. */
  missedByDeploy: boolean
  /** Always set, unlike the optional field on the item: falls back to the item
   *  id, which makes a row with no carousel exactly one post. */
  postKey: string
}

/** Same join as joinStories, over items instead of story posts. Pass RAW
 *  detections — the number of documents per item is what says how many images
 *  were examined. */
export function joinCampaign(items: CampaignItem[], detections: DetectionRow[]): CampaignRow[] {
  const byItem = new Map<string, DetectionRow[]>()
  for (const d of detections) {
    if (!d.post_id) continue
    const arr = byItem.get(d.post_id)
    if (arr) arr.push(d)
    else byItem.set(d.post_id, [d])
  }
  return items.map((it) => {
    const group = byItem.get(it.itemId) ?? []
    const best = pickBest(group)
    return {
      ...it,
      detection: best,
      confidence: best?.confidence ?? null,
      verdict: verdictFor(best),
      framesJudged: framesJudgedIn(group),
      coverOnly: best?.cover_only === true,
      placement: best?.verify_placement ?? null,
      source: it.source ?? 'roster',
      missedByDeploy: best?.detected === true && best?.found_at_prod_res === false,
      // Scoped by account: two people can post carousels whose shortcodes are
      // unrelated, but nothing guarantees the ids never collide across
      // archives, and a collision here would silently merge two posts into one.
      postKey: `${(it.platformHandle || it.creatorHandle || '').toLowerCase()}/${
        it.postKey || it.itemId}`,
    }
  })
}

function pickBest(group: DetectionRow[]): DetectionRow | null {
  if (group.length === 0) return null
  const rejected = group.find((d) => d.is_false_positive === true)
  if (rejected) return rejected
  const hits = group.filter((d) => d.detected === true)
  if (hits.length > 0) return hits.reduce((a, b) => ((b.confidence ?? 0) > (a.confidence ?? 0) ? b : a))
  const near = group.filter(isNearMiss)
  const pool = near.length > 0 ? near : group
  return pool.reduce((a, b) => ((b.confidence ?? 0) > (a.confidence ?? 0) ? b : a))
}

function verdictFor(d: DetectionRow | null): StoryVerdict {
  if (!d) return 'unanalysed'
  if (d.is_false_positive === true) return 'rejected'
  if (d.detected !== true) return isNearMiss(d) ? 'near' : 'absent'
  return detectionQuality(d).quality === 'clear' ? 'visible' : 'small'
}

function framesJudgedIn(group: DetectionRow[]): number {
  if (group.length === 0) return 0
  const stated = group.reduce((sum, d) => sum + (d.frames_judged ?? 0), 0)
  return Math.max(stated, group.length)
}

// ─────────────────────────── rollup ───────────────────────────

export type SurfaceStats = {
  /** Rows: one per image or video actually looked at. A ten-slide carousel is
   *  ten of these, which is right for "how much did we examine" and wrong for
   *  "how much did they post". */
  items: number
  /** Posts: what a person would count. The same carousel is one. On the real
   *  fixture the gap is 1150 rows to 210 posts, and 37 sightings to 18. */
  posts: number
  /** Posts with Stëlz in at least one slide. Never larger than `posts`. */
  postsWithStelz: number
  judged: number
  imagesSeen: number
  withStelz: number
  near: number
  unanalysed: number
  coverOnly: number
  /** Sightings where the wordmark was NOT on a can. A subset of withStelz, not
   *  an addition to it. */
  offContainer: number
  /** The one metric this surface actually publishes. Null when it publishes
   *  none — a story has no view count and 0 would be a claim, not a blank. */
  metric: number | null
  lastPostedAt: string | null
}

const EMPTY: SurfaceStats = {
  items: 0, posts: 0, postsWithStelz: 0, judged: 0, imagesSeen: 0, withStelz: 0,
  near: 0, unanalysed: 0, coverOnly: 0, offContainer: 0, metric: null,
  lastPostedAt: null,
}

export type CampaignCreator = {
  handle: string
  fullName: string | null
  avatarUrl: string | null
  followers: number | null
  bySurface: Record<Surface, SurfaceStats>
  /** Content items across every surface. Safe to add — these are counts of
   *  things, not audience measurements. */
  items: number
  withStelz: number
  near: number
  /** True when this creator is on the roster and posted nothing anywhere.
   *  Silence from someone being paid to post is a finding, not an empty row. */
  silent: boolean
}

/** One side of the roster/discovery split.
 *
 *  Counts only. No metric field on purpose: adding a stranger's TikTok plays to
 *  a booked creator's would produce exactly the "total reach" this file exists
 *  to prevent, and the per-surface figures already live on `bySurface`. */
export type SourceStats = {
  items: number
  /** Posts, not rows. See SurfaceStats.posts. */
  posts: number
  postsWithStelz: number
  judged: number
  withStelz: number
  near: number
  /** Distinct accounts. For discovery this is the number that matters: "9
   *  sightings" from one person is a fan, from nine people it is a trend. */
  accounts: number
  tiktokViews: number
}

export type CampaignRollup = {
  creators: CampaignCreator[]
  rosterSize: number
  delivered: number       // creators with at least one item
  silent: number
  items: number
  /** Posts, not rows. See SurfaceStats.posts. */
  posts: number
  postsWithStelz: number
  judged: number
  imagesSeen: number
  withStelz: number
  near: number
  unanalysed: number
  /** Of the sightings, how many were signage, merchandise or clothing rather
   *  than a can in someone's hand. A subset of withStelz. */
  offContainer: number
  /** Of the sightings, how many the DEPLOYED backend would currently miss. A
   *  subset of withStelz, and a number about the deploy rather than the
   *  campaign — but one nobody should have to discover from a footnote. */
  missedByDeploy: number
  bySurface: Record<Surface, SurfaceStats>
  /** The split the client asked for: what the people we pay delivered, versus
   *  what turned up on its own. Kept apart at every level. */
  bySource: Record<Source, SourceStats>
  /** Named, not "reach": TikTok is the only surface here that publishes views.
   *  Kept out of every other total on purpose. */
  tiktokViews: number
  pollVotes: number
  postLikes: number
}

const SURFACES: Surface[] = ['story', 'post', 'tiktok']

function blankSurfaces(): Record<Surface, SurfaceStats> {
  return { story: { ...EMPTY }, post: { ...EMPTY }, tiktok: { ...EMPTY } }
}

/** The metric a surface publishes, or null when it publishes none. */
export function metricFor(r: CampaignRow): number | null {
  if (r.surface === 'tiktok') return r.views
  if (r.surface === 'post') return r.likes
  return r.pollVotes && r.pollVotes > 0 ? r.pollVotes : null
}

/**
 * @param roster handles that SHOULD have posted. A member who posted nothing
 *   stays in the table at zero — that is the row a brand most needs to see.
 */
export function campaignRollup(
  rows: CampaignRow[],
  profiles: Record<string, CreatorProfile> = {},
  roster: string[] = [],
): CampaignRollup {
  const byCreator = new Map<string, CampaignCreator>()
  const accounts: Record<Source, Set<string>> = { roster: new Set(), discovery: new Set() }
  const blank = (handle: string): CampaignCreator => ({
    handle,
    fullName: profiles[handle]?.fullName ?? null,
    avatarUrl: profiles[handle]?.avatarUrl ?? null,
    followers: profiles[handle]?.followerCount ?? null,
    bySurface: blankSurfaces(),
    items: 0, withStelz: 0, near: 0, silent: true,
  })
  for (const h of roster) byCreator.set(h.toLowerCase(), blank(h.toLowerCase()))

  const blankSource = (): SourceStats => ({
    items: 0, posts: 0, postsWithStelz: 0, judged: 0, withStelz: 0, near: 0,
    accounts: 0, tiktokViews: 0,
  })

  const out: CampaignRollup = {
    creators: [], rosterSize: roster.length, delivered: 0, silent: 0,
    items: 0, posts: 0, postsWithStelz: 0, judged: 0, imagesSeen: 0,
    withStelz: 0, near: 0, unanalysed: 0,
    offContainer: 0, missedByDeploy: 0,
    bySurface: blankSurfaces(),
    bySource: { roster: blankSource(), discovery: blankSource() },
    tiktokViews: 0, pollVotes: 0, postLikes: 0,
  }

  // Counting posts means counting distinct keys per bucket, and a bucket only
  // knows its own total. The sets are kept beside the stats objects and folded
  // in once at the end, so `posts` can never drift from the rows that produced
  // it the way a hand-maintained counter would.
  //
  // RETURNS whether this bucket had not seen the post before, and every metric
  // below is gated on it. A carousel arrives as one row PER SLIDE — each slide
  // is a separate image to judge, so counting them as items is right — but all
  // of them carry the same post-level like count, because that is the only like
  // count the post has. Adding it per row reported 254.589 post likes on the
  // Lowlands set where 103.007 was true: a 147% overstatement, produced by a
  // handful of long carousels. Judging counts slides; audience figures count
  // posts, and the two must not share a counter.
  const keys = new WeakMap<object, { all: Set<string>; hit: Set<string> }>()
  const track = (bucket: object, r: CampaignRow): boolean => {
    let k = keys.get(bucket)
    if (!k) keys.set(bucket, (k = { all: new Set(), hit: new Set() }))
    const firstOfPost = !k.all.has(r.postKey)
    k.all.add(r.postKey)
    if (isStelzStory(r.verdict)) k.hit.add(r.postKey)
    return firstOfPost
  }
  const settle = (bucket: { posts: number; postsWithStelz: number }) => {
    const k = keys.get(bucket)
    bucket.posts = k?.all.size ?? 0
    bucket.postsWithStelz = k?.hit.size ?? 0
  }

  const bump = (s: SurfaceStats, r: CampaignRow) => {
    s.items += 1
    const firstOfPost = track(s, r)
    s.imagesSeen += r.framesJudged
    if (r.verdict === 'unanalysed') s.unanalysed += 1
    else s.judged += 1
    if (isStelzStory(r.verdict)) s.withStelz += 1
    if (r.verdict === 'near') s.near += 1
    if (r.coverOnly) s.coverOnly += 1
    if (r.placement && isStelzStory(r.verdict)) s.offContainer += 1
    const m = metricFor(r)
    if (m != null && firstOfPost) s.metric = (s.metric ?? 0) + m
    if (r.postedAt && (!s.lastPostedAt || r.postedAt > s.lastPostedAt)) {
      s.lastPostedAt = r.postedAt
    }
  }

  for (const r of rows) {
    const h = (r.creatorHandle || '').toLowerCase()
    // The creator table answers "who on the roster delivered what", and
    // `delivered` / `silent` are contract numbers. A stranger found by hashtag
    // is not a roster member who delivered — adding them here would list
    // dozens of accounts nobody booked and quietly report 60/28 delivered.
    // Discovery accounts are summarised on bySource.discovery.accounts instead.
    if (h && r.source !== 'discovery') {
      const c = byCreator.get(h) ?? blank(h)
      byCreator.set(h, c)
      c.silent = false
      c.items += 1
      if (isStelzStory(r.verdict)) c.withStelz += 1
      if (r.verdict === 'near') c.near += 1
      bump(c.bySurface[r.surface], r)
    }
    bump(out.bySurface[r.surface], r)

    out.items += 1
    const firstForOut = track(out, r)
    out.imagesSeen += r.framesJudged
    if (r.verdict === 'unanalysed') out.unanalysed += 1
    else out.judged += 1
    if (isStelzStory(r.verdict)) out.withStelz += 1
    if (r.verdict === 'near') out.near += 1
    if (r.placement && isStelzStory(r.verdict)) out.offContainer += 1
    if (r.missedByDeploy) out.missedByDeploy += 1

    const src = out.bySource[r.source]
    src.items += 1
    const firstForSrc = track(src, r)
    if (r.verdict === 'unanalysed') { /* not judged; counted in items only */ }
    else src.judged += 1
    if (isStelzStory(r.verdict)) src.withStelz += 1
    if (r.verdict === 'near') src.near += 1
    if (r.surface === 'tiktok' && firstForSrc) src.tiktokViews += r.views ?? 0
    accounts[r.source].add((r.platformHandle || r.creatorHandle || '').toLowerCase())

    // Kept in three separate fields rather than one "reach". Nothing in this
    // file adds them together, and nothing downstream should either. All three
    // count each post once — see `track`.
    if (r.surface === 'tiktok' && firstForOut) out.tiktokViews += r.views ?? 0
    if (r.surface === 'story' && firstForOut) out.pollVotes += r.pollVotes ?? 0
    if (r.surface === 'post' && firstForOut) out.postLikes += r.likes ?? 0
  }

  settle(out)
  for (const s of SURFACES) settle(out.bySurface[s])
  for (const c of byCreator.values()) {
    for (const s of SURFACES) settle(c.bySurface[s])
    if (c.silent) out.silent += 1
    else out.delivered += 1
  }
  for (const s of ['roster', 'discovery'] as Source[]) settle(out.bySource[s])
  out.bySource.roster.accounts = accounts.roster.size
  out.bySource.discovery.accounts = accounts.discovery.size

  out.creators = [...byCreator.values()].sort(
    (a, b) => b.withStelz - a.withStelz || b.items - a.items || a.handle.localeCompare(b.handle),
  )
  return out
}

/** Share of judged items containing Stëlz, or null when nothing was judged —
 *  a 0% that only means "we have not looked" is a lie in a KPI box. */
export function stelzShare(r: { judged: number; withStelz: number }): number | null {
  if (r.judged <= 0) return null
  return (r.withStelz / r.judged) * 100
}

export { SURFACES }
