// The rules this page cannot be allowed to break.
//
// The load-bearing one is the metric rule: TikTok plays, poll votes and post
// likes are three different events, and a single "reach" that adds them is the
// kind of number that survives all the way into a client deck before anyone
// asks what it means.
import { describe, expect, it } from 'vitest'
import {
  joinCampaign, campaignRollup, stelzShare, metricFor, surfaceOf, SURFACE_LABEL, SURFACES,
  type CampaignItem,
} from './campaign'
import type { DetectionRow } from './types'

const item = (over: Partial<CampaignItem> & { itemId: string; creatorHandle: string }): CampaignItem => ({
  platform: 'instagram', surface: 'story', url: null, coverUrl: null, videoUrl: null,
  mediaType: 'image', postedAt: '2026-08-20T10:00:00Z', caption: null,
  hashtags: [], mentions: [], videoDuration: null,
  views: null, likes: null, comments: null, shares: null, saves: null, pollVotes: null,
  isPaidPartnership: false, ...over,
})

const det = (over: Partial<DetectionRow> & { post_id: string }): DetectionRow => ({
  detection_id: `d_${over.post_id}`, creator_id: null, creator_handle: 'anna',
  creator_category: null, platform: 'instagram', product_line: null,
  confidence: 0.95, size_in_frame: 'medium', is_primary_subject: true,
  image_url: null, stored_path: null, post_url: null, post_caption: null,
  posted_at: '2026-08-20T10:00:00Z', likes_count: null, comments_count: null,
  views_count: null, follower_count: null, creator_tier: 'tier_2', verified: null,
  context: null, post_hashtags: null, post_mentions: null, music: null, extras: null,
  surface_type: null, visible_text: null, false_positive_risk: null,
  people_count: null, setting: null, activity: null, gate: null,
  verify_verdict: null, verify_brand: null, verify_reason: null,
  sentiment: null, sentiment_score: null, sentiment_rationale: null,
  brand_id: 'stelz', detected: true, is_false_positive: null, ...over,
})

describe('metrics per surface', () => {
  it('never adds a TikTok view to a poll vote', () => {
    // The whole reason bySurface exists. If these ever land in one field the
    // page is reporting an audience number that describes nothing.
    const rows = joinCampaign([
      item({ itemId: 'a', creatorHandle: 'anna', surface: 'tiktok', platform: 'tiktok', views: 10_000 }),
      item({ itemId: 'b', creatorHandle: 'anna', surface: 'story', pollVotes: 300 }),
      item({ itemId: 'c', creatorHandle: 'anna', surface: 'post', likes: 50 }),
    ], [])
    const r = campaignRollup(rows)
    expect(r.tiktokViews).toBe(10_000)
    expect(r.pollVotes).toBe(300)
    expect(r.postLikes).toBe(50)
    expect(r.bySurface.tiktok.metric).toBe(10_000)
    expect(r.bySurface.story.metric).toBe(300)
    expect(r.bySurface.post.metric).toBe(50)
    // And no field anywhere holds 10,350.
    const total = 10_000 + 300 + 50
    expect(Object.values(r).some((v) => v === total)).toBe(false)
  })

  it('reports null, not zero, for a surface that publishes no such number', () => {
    // Instagram gives story views to the account holder alone. A 0 would read
    // as "nobody watched" for a figure that does not exist.
    const rows = joinCampaign([item({ itemId: 'a', creatorHandle: 'anna', surface: 'story' })], [])
    expect(metricFor(rows[0])).toBeNull()
    expect(campaignRollup(rows).bySurface.story.metric).toBeNull()
  })

  it('names every surface and its metric', () => {
    for (const s of SURFACES) {
      expect(SURFACE_LABEL[s]).toBeTruthy()
    }
  })
})

describe('verdicts across surfaces', () => {
  it('joins detections onto items by id', () => {
    const rows = joinCampaign(
      [item({ itemId: 'tiktok_video1', creatorHandle: 'anna', surface: 'tiktok', platform: 'tiktok' })],
      [det({ post_id: 'tiktok_video1' })],
    )
    expect(rows[0].verdict).toBe('visible')
  })

  it('keeps an overturned hit as "near", not as "absent"', () => {
    // The state that exists because a rejected hit used to be indistinguishable
    // from an empty field.
    const rows = joinCampaign(
      [item({ itemId: 'p1', creatorHandle: 'anna' })],
      [det({ post_id: 'p1', detected: false, confidence: 0.8,
             gate: 'rejected_by_verifier', verify_verdict: 'rejected' })],
    )
    expect(rows[0].verdict).toBe('near')
    expect(campaignRollup(rows).near).toBe(1)
    // A question is not a sighting.
    expect(campaignRollup(rows).withStelz).toBe(0)
  })

  it('an item with no detection is unanalysed, never a miss', () => {
    const rows = joinCampaign([item({ itemId: 'p1', creatorHandle: 'anna' })], [])
    expect(rows[0].verdict).toBe('unanalysed')
    const r = campaignRollup(rows)
    expect(r.unanalysed).toBe(1)
    expect(r.judged).toBe(0)
    expect(stelzShare(r)).toBeNull()
  })

  it('flags a verdict reached on the cover alone', () => {
    // A thumbnail is a chosen frame. "Nothing found" on one is a much weaker
    // claim than "nothing found" across the whole clip, and the page says so.
    const rows = joinCampaign(
      [item({ itemId: 'v1', creatorHandle: 'anna', surface: 'tiktok', platform: 'tiktok', mediaType: 'video' })],
      [det({ post_id: 'v1', detected: false, cover_only: true })],
    )
    expect(rows[0].coverOnly).toBe(true)
    expect(campaignRollup(rows).bySurface.tiktok.coverOnly).toBe(1)
  })

  it('counts images looked at, not items', () => {
    const rows = joinCampaign(
      [item({ itemId: 'v1', creatorHandle: 'anna', surface: 'tiktok', platform: 'tiktok' })],
      [det({ post_id: 'v1', detected: false, frames_judged: 9 })],
    )
    expect(rows[0].framesJudged).toBe(9)
    expect(campaignRollup(rows).imagesSeen).toBe(9)
  })
})

describe('who delivered', () => {
  it('keeps a roster member who posted nothing, at zero', () => {
    // Silence from someone being paid to post is the finding, not a gap.
    const rows = joinCampaign([item({ itemId: 'a', creatorHandle: 'anna' })], [])
    const r = campaignRollup(rows, {}, ['anna', 'bo', 'cas'])
    expect(r.rosterSize).toBe(3)
    expect(r.delivered).toBe(1)
    expect(r.silent).toBe(2)
    const bo = r.creators.find((c) => c.handle === 'bo')!
    expect(bo.silent).toBe(true)
    expect(bo.items).toBe(0)
  })

  it('splits one creator across the three surfaces', () => {
    const rows = joinCampaign([
      item({ itemId: 's1', creatorHandle: 'anna', surface: 'story' }),
      item({ itemId: 's2', creatorHandle: 'anna', surface: 'story' }),
      item({ itemId: 'p1', creatorHandle: 'anna', surface: 'post' }),
      item({ itemId: 't1', creatorHandle: 'anna', surface: 'tiktok', platform: 'tiktok', views: 900 }),
    ], [])
    const anna = campaignRollup(rows).creators[0]
    expect(anna.bySurface.story.items).toBe(2)
    expect(anna.bySurface.post.items).toBe(1)
    expect(anna.bySurface.tiktok.items).toBe(1)
    expect(anna.bySurface.tiktok.metric).toBe(900)
    // Counting content is fine — these are things, not audience measurements.
    expect(anna.items).toBe(4)
  })

  it('sorts creators who showed Stëlz first', () => {
    const rows = joinCampaign(
      [item({ itemId: 'a', creatorHandle: 'anna' }), item({ itemId: 'b', creatorHandle: 'bo' })],
      [det({ post_id: 'b' })],
    )
    expect(campaignRollup(rows).creators[0].handle).toBe('bo')
  })
})

describe('Stëlz that is not on a can', () => {
  // A festival sponsorship is bought partly as signage: a branded bar front, a
  // parasol, a cooler, an inflatable, a cap. The verifier used to answer
  // "not_a_container" for every one of those and the detection was deleted —
  // 22 of 41 rejections on the Lowlands archive. They are hits, but they are a
  // different KIND of hit, and a report that flattens them into one number
  // loses the distinction a sponsor is actually buying.
  const rows = () => joinCampaign([
    item({ itemId: 'bar', creatorHandle: 'sterre', surface: 'post' }),
    item({ itemId: 'ring', creatorHandle: 'daan', surface: 'post' }),
    item({ itemId: 'can', creatorHandle: 'daan', surface: 'post' }),
  ], [
    det({ post_id: 'bar', verify_placement: 'signage', verify_verdict: 'confirmed' }),
    det({ post_id: 'ring', verify_placement: 'merchandise', verify_verdict: 'confirmed' }),
    det({ post_id: 'can' }),
  ])

  it('counts a placement as a sighting', () => {
    const r = campaignRollup(rows())
    expect(r.withStelz).toBe(3)
  })

  it('counts off-container placements as a SUBSET, never an addition', () => {
    const r = campaignRollup(rows())
    expect(r.offContainer).toBe(2)
    expect(r.offContainer).toBeLessThanOrEqual(r.withStelz)
    expect(r.bySurface.post.offContainer).toBe(2)
  })

  it('carries the placement onto the row so the panel can name it', () => {
    const byId = Object.fromEntries(rows().map((r) => [r.itemId, r]))
    expect(byId.bar.placement).toBe('signage')
    expect(byId.ring.placement).toBe('merchandise')
    expect(byId.can.placement).toBeNull()
  })

  it('never counts a placement on something that is not a sighting', () => {
    // A rejected row carrying a stale placement must not inflate the count.
    const r = campaignRollup(joinCampaign(
      [item({ itemId: 'x', creatorHandle: 'anna', surface: 'post' })],
      [det({ post_id: 'x', detected: false, verify_placement: 'signage' })],
    ))
    expect(r.withStelz).toBe(0)
    expect(r.offContainer).toBe(0)
  })
})

describe('the gap between this page and the deployed backend', () => {
  // The page is generated from an archive that can be analysed at the images'
  // own resolution. The deployed function downscales everything to 512px
  // first, and on the Lowlands archive that costs 13 of 46 sightings —
  // several of them confirmed by eye. Left unstated, the count would simply
  // drop after a deploy and read as a scraping failure.
  it('flags a sighting the deploy would miss', () => {
    const rows = joinCampaign(
      [item({ itemId: 'a', creatorHandle: 'niek', surface: 'tiktok', platform: 'tiktok' })],
      [det({ post_id: 'a', found_at_prod_res: false })],
    )
    expect(rows[0].missedByDeploy).toBe(true)
    expect(campaignRollup(rows).missedByDeploy).toBe(1)
  })

  it('says nothing when the deploy would find it too', () => {
    const rows = joinCampaign(
      [item({ itemId: 'a', creatorHandle: 'lize', surface: 'post' })],
      [det({ post_id: 'a', found_at_prod_res: true })],
    )
    expect(rows[0].missedByDeploy).toBe(false)
    expect(campaignRollup(rows).missedByDeploy).toBe(0)
  })

  it('stays silent rather than guessing when the field is absent', () => {
    // Production detections never carry it — a deployed detection IS at
    // production resolution. Undefined must not render as "not live".
    const rows = joinCampaign(
      [item({ itemId: 'a', creatorHandle: 'lize', surface: 'post' })],
      [det({ post_id: 'a' })],
    )
    expect(rows[0].missedByDeploy).toBe(false)
  })

  it('never counts a miss on something that was not a sighting', () => {
    const rows = joinCampaign(
      [item({ itemId: 'a', creatorHandle: 'lize', surface: 'post' })],
      [det({ post_id: 'a', detected: false, found_at_prod_res: false })],
    )
    expect(campaignRollup(rows).missedByDeploy).toBe(0)
  })
})

describe('roster content and loose content are never one number', () => {
  // The client asked for this split by name. Roster content answers "did the
  // people we booked deliver" — a contract question, where silence is the
  // finding. Discovery content answers "is the can showing up on its own" — a
  // marketing question, where silence means nothing and one sighting means a
  // lot. A total containing both counts strangers as deliverables.
  const rows = () => joinCampaign([
    item({ itemId: 'r1', creatorHandle: 'lize', platformHandle: 'lize', surface: 'tiktok', platform: 'tiktok', views: 10_000, source: 'roster' }),
    item({ itemId: 'd1', creatorHandle: 'vreemde', platformHandle: 'vreemde', surface: 'tiktok', platform: 'tiktok', views: 500, source: 'discovery', foundVia: 'lowlands' }),
    item({ itemId: 'd2', creatorHandle: 'vreemde', platformHandle: 'vreemde', surface: 'tiktok', platform: 'tiktok', views: 700, source: 'discovery', foundVia: 'stelz' }),
  ], [
    det({ post_id: 'r1' }),
    det({ post_id: 'd1' }),
    det({ post_id: 'd2', detected: false }),
  ])

  it('keeps the two sets apart', () => {
    const r = campaignRollup(rows())
    expect(r.bySource.roster.withStelz).toBe(1)
    expect(r.bySource.discovery.withStelz).toBe(1)
    expect(r.bySource.roster.items).toBe(1)
    expect(r.bySource.discovery.items).toBe(2)
  })

  it('never lets paid views and organic views share a field', () => {
    const r = campaignRollup(rows())
    expect(r.bySource.roster.tiktokViews).toBe(10_000)
    expect(r.bySource.discovery.tiktokViews).toBe(1_200)
    // The page-level figure still exists, but the split must not be recoverable
    // only by subtraction — both halves are named.
    expect(r.bySource.roster.tiktokViews + r.bySource.discovery.tiktokViews)
      .toBe(r.tiktokViews)
  })

  it('counts distinct accounts, not posts', () => {
    // Nine sightings from one enthusiast and nine from nine strangers are
    // completely different findings.
    expect(campaignRollup(rows()).bySource.discovery.accounts).toBe(1)
  })

  it('treats an item with no source as roster', () => {
    // Every archive that predates discovery is roster content. Guessing
    // 'discovery' would invent organic reach out of paid deliverables.
    const r = joinCampaign([item({ itemId: 'x', creatorHandle: 'lize' })], [])
    expect(r[0].source).toBe('roster')
  })

  it('carries the hashtag that found it', () => {
    const byId = Object.fromEntries(rows().map((r) => [r.itemId, r]))
    expect(byId.d1.foundVia).toBe('lowlands')
    expect(byId.r1.foundVia).toBeUndefined()
  })
})

describe('the creator table stays a roster table', () => {
  // "Wie leverde er niets" is a contract question about 28 booked people. A
  // hashtag harvest adds dozens of strangers, and letting them into this table
  // would report 60 of 28 delivered — a number that is not only wrong but
  // wrong in the flattering direction.
  const rows = joinCampaign([
    item({ itemId: 'r1', creatorHandle: 'lize', surface: 'post' }),
    item({ itemId: 'd1', creatorHandle: 'vreemde', surface: 'tiktok', platform: 'tiktok', source: 'discovery' }),
  ], [det({ post_id: 'r1' }), det({ post_id: 'd1' })])

  it('lists only roster creators', () => {
    const r = campaignRollup(rows, {}, ['lize', 'daan'])
    expect(r.creators.map((c) => c.handle).sort()).toEqual(['daan', 'lize'])
  })

  it('does not let a stranger count as a delivery', () => {
    const r = campaignRollup(rows, {}, ['lize', 'daan'])
    expect(r.delivered).toBe(1)
    expect(r.silent).toBe(1)
    expect(r.rosterSize).toBe(2)
  })

  it('still counts discovery content in the page totals', () => {
    // Excluded from the creator table, NOT from the page. The sighting is real.
    const r = campaignRollup(rows, {}, ['lize', 'daan'])
    expect(r.items).toBe(2)
    expect(r.withStelz).toBe(2)
    expect(r.bySurface.tiktok.items).toBe(1)
  })
})

describe('carousels are one post, not ten', () => {
  // An Instagram carousel is archived per slide, because the can is rarely on
  // slide one and judging a ten-slide post by its cover is how a
  // brand-visibility tool reports zero forever. Counting those slides as posts
  // is a different mistake: on the real fixture it turned 210 posts into 1150
  // "items" and 18 sightings into 37.
  const slide = (n: number) => item({
    itemId: `instagram_postABCs${n}`, creatorHandle: 'lize', platformHandle: 'lize',
    surface: 'post', postKey: 'ABC', slot: n, slots: 3,
  })

  const rows = joinCampaign(
    [0, 1, 2].map(slide),
    [det({ post_id: 'instagram_postABCs1', detected: true, confidence: 0.95 }),
     det({ post_id: 'instagram_postABCs0', detected: false, confidence: 0.1 }),
     det({ post_id: 'instagram_postABCs2', detected: false, confidence: 0.1 })],
  )

  it('counts three images and one post', () => {
    const r = campaignRollup(rows, {}, ['lize'])
    expect(r.items).toBe(3)
    expect(r.posts).toBe(1)
    expect(r.bySurface.post.items).toBe(3)
    expect(r.bySurface.post.posts).toBe(1)
  })

  it('counts a post once however many of its slides show the can', () => {
    const r = campaignRollup(rows, {}, ['lize'])
    expect(r.withStelz).toBe(1)          // one slide had it
    expect(r.postsWithStelz).toBe(1)     // and that is one post
    expect(r.bySource.roster.posts).toBe(1)
    expect(r.bySource.roster.postsWithStelz).toBe(1)
  })

  it('never reports more posts with Stëlz than posts', () => {
    const r = campaignRollup(rows, {}, ['lize'])
    expect(r.postsWithStelz).toBeLessThanOrEqual(r.posts)
    for (const s of SURFACES) {
      expect(r.bySurface[s].postsWithStelz).toBeLessThanOrEqual(r.bySurface[s].posts)
      expect(r.bySurface[s].posts).toBeLessThanOrEqual(r.bySurface[s].items)
    }
  })

  it('counts a post\'s likes once, not once per slide', () => {
    // THE SAME MISTAKE ONE LEVEL DOWN. Slides are counted as items on purpose —
    // each is an image to judge — but every slide carries the SAME post-level
    // like count, because that is the only like count the post has. Adding it
    // per row reported 254.589 post likes on the real Lowlands set where
    // 103.007 was true, off by 147% on a figure a client reads first.
    const liked = joinCampaign(
      [0, 1, 2].map((n) => ({ ...slide(n), likes: 2_179 })),
      [det({ post_id: 'instagram_postABCs1', detected: true, confidence: 0.95 })],
    )
    const r = campaignRollup(liked, {}, ['lize'])
    expect(r.items).toBe(3)
    expect(r.posts).toBe(1)
    expect(r.postLikes).toBe(2_179)
    expect(r.bySurface.post.metric).toBe(2_179)
    expect(r.creators[0].bySurface.post.metric).toBe(2_179)
    expect(Object.values(r)).not.toContain(6_537)
  })

  it('keeps two people apart when their shortcodes collide', () => {
    // postKey is scoped by account on purpose: nothing guarantees ids are
    // unique across archives, and a collision would silently merge two posts.
    const two = joinCampaign([
      { ...item({ itemId: 'a', creatorHandle: 'lize', platformHandle: 'lize', surface: 'post' }), postKey: 'X' },
      { ...item({ itemId: 'b', creatorHandle: 'daan', platformHandle: 'daan', surface: 'post' }), postKey: 'X' },
    ], [])
    expect(campaignRollup(two, {}, ['lize', 'daan']).posts).toBe(2)
  })

  it('treats a row with no carousel as exactly one post', () => {
    const one = joinCampaign(
      [item({ itemId: 'tiktok_video1', creatorHandle: 'lize', platformHandle: 'lize', surface: 'tiktok' })],
      [])
    expect(campaignRollup(one, {}, ['lize']).posts).toBe(1)
  })
})

// The bug this guards: the event page used to default a missing `surface` to
// 'post'. Only the imported rows carry that field — every row the scheduled
// cloud scans write has `contentType` and `platform` instead — so once those
// rows reached the page, each scanned TikTok was counted as an Instagram post
// and the TikTok KPI stayed on zero over a grid full of clips.
describe('surfaceOf', () => {
  it('takes the stored surface when the row has one', () => {
    expect(surfaceOf({ surface: 'tiktok', platform: 'instagram' })).toBe('tiktok')
    expect(surfaceOf({ surface: 'story', contentType: 'video' })).toBe('story')
  })

  it('reads a scanner-written story off contentType', () => {
    expect(surfaceOf({ contentType: 'story', platform: 'instagram' })).toBe('story')
  })

  it('reads a scanner-written TikTok off platform', () => {
    expect(surfaceOf({ contentType: 'video', platform: 'tiktok' })).toBe('tiktok')
  })

  it('prefers story over platform: a TikTok row is never an IG story', () => {
    // contentType wins, so an instagram story stays a story even though the
    // platform check sits below it. The ordering is the assertion.
    expect(surfaceOf({ contentType: 'story', platform: 'tiktok' })).toBe('story')
  })

  it('falls back to an IG post, and ignores a surface it does not know', () => {
    expect(surfaceOf({ platform: 'instagram', contentType: 'image' })).toBe('post')
    expect(surfaceOf({})).toBe('post')
    expect(surfaceOf({ surface: 'reel' })).toBe('post')
  })
})
