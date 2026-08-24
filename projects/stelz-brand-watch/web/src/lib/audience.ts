// The people around the campaign — read side.
//
// WHAT THIS ANSWERS THAT FOLLOWER COUNTS CANNOT. "28 creators, 2,8M followers
// between them" is a number with no way of telling whether that is 2,8M people
// or 80.000 people counted 28 times. Comments are the only per-person signal
// either platform gives away for free, so the overlap becomes measurable:
// 2.040 people commented on the roster's posts, and 154 of them commented on
// more than one booked creator.
//
// WHAT IS DELIBERATELY ABSENT. No age, no gender, no city. Of 1.089 bios with
// any text in them, exactly ONE states an age under the rule in
// communities.selfReportedAge. Everything else would be inferred from a number
// that happened to appear in a bio, and a demographic split built that way is
// the sort of figure a client repeats in a meeting and then has to retract.
//
// Shapes mirror tools/stelz_brand_watch/76_audience.py exactly. That script
// makes no network call: it re-reads raw Apify payloads already on disk and
// asks a different question of them.

export type Ranked = { label: string; count: number }

export type Commenter = {
  handle: string
  comments: number
  /** Accounts this person commented on, deduped. Its LENGTH is the point. */
  creators: string[]
  /** How many of those are people Stëlz is paying. */
  rosterReached: number
  firstAt: string | null
  lastAt: string | null
}

export type TaggedAccount = {
  handle: string
  fullName: string | null
  times: number
  taggedBy: string[]
  onRoster: boolean
}

export type AudienceAccount = {
  handle: string
  platform: 'tiktok'
  source: 'roster' | 'discovery'
  fullName: string | null
  followers: number | null
  hearts: number | null
  videos: number | null
  following: number | null
  verified: boolean
  bio: string | null
  posts: number
  withStelz: number
}

export type AccountStats = {
  accounts: number
  followersKnownFor: number
  /** Median, never mean: one 1,2M account among 337 festival-goers would drag
   *  a mean to a number that describes nobody who was there. */
  medianFollowers: number | null
  totalFollowers: number
  verified: number
  withStelz: number
  /** Accounts in this group whose bio has any text at all. */
  withBio: number
  /** …and how many of those state an age, under the same rule as
   *  communities.selfReportedAge. This is the count behind the tab's claim that
   *  there is no age data — measured over the accounts the tab actually shows,
   *  not over a wider bio corpus, because a true number under someone else's
   *  denominator is still a false claim. */
  withAge: number
}

export type Audience = {
  eventId: string
  commenters: {
    top: Commenter[]
    people: number
    comments: number
    postsWithComments: number
    /** People who commented on 2+ different accounts. */
    shared: number
    listed: number
    /** creators-reached -> how many people reached exactly that many. */
    reachDistribution: Record<string, number>
  }
  tagged: {
    top: TaggedAccount[]
    accounts: number
    onRoster: number
    tags: number
    listed: number
  }
  accounts: {
    top: AudienceAccount[]
    roster: AccountStats
    discovery: AccountStats
    listed: number
    total: number
  }
  context: {
    languages: Ranked[]
    languagesKnownFor: number
    languagePosts: number
    sounds: Ranked[]
    /** Posts that carried any sound — the denominator a "this sound was on X%
     *  of posts" claim needs. */
    soundsKnownFor: number
    /** How many DIFFERENT sounds those were. Not a denominator: dividing a post
     *  count by this mixes units and produces a percentage of nothing. */
    soundsDistinct: number
    places: Ranked[]
    placesKnownFor: number
    placePosts: number
  }
}

/**
 * How much of the commenting audience is shared between booked creators.
 *
 * The one figure on the page that says whether a roster of 28 bought 28
 * audiences or one audience 28 times. Returned with its denominator attached
 * because "5,4% overlap" and "154 of 2.040 people" land very differently and
 * only the second can be checked.
 */
export function overlap(a: Audience): { shared: number; people: number; pct: number } {
  const { shared, people } = a.commenters
  return { shared, people, pct: people > 0 ? (shared / people) * 100 : 0 }
}

/** The reach distribution as rows, widest first, with the tail folded in.
 *
 *  1.886 of 2.040 people commented on exactly one creator. That is the honest
 *  shape of the finding and it has to stay visible: without the "1" row the
 *  154 look like the whole story. */
export function reachBands(a: Audience): { reached: number; people: number }[] {
  return Object.entries(a.commenters.reachDistribution)
    .map(([reached, people]) => ({ reached: Number(reached), people }))
    .sort((x, y) => y.reached - x.reached)
}

/** Share of a ranked list's leader, against the total that carried the field.
 *  Null when nothing carried it — 0% would claim a measurement. */
export function leadShare(rows: Ranked[], knownFor: number): number | null {
  if (!rows.length || knownFor <= 0) return null
  return (rows[0].count / knownFor) * 100
}

/** Accounts split by whether Stëlz was actually in frame.
 *
 *  A festival-goer who posted about Lowlands is context; one who held a can is
 *  a finding. The tab shows both counts rather than only the second, because
 *  the ratio is what says how present the brand was in that crowd. */
export function stelzShareOf(s: AccountStats): number | null {
  return s.accounts > 0 ? (s.withStelz / s.accounts) * 100 : null
}
