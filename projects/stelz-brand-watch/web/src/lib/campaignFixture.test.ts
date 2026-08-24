/// <reference types="node" />
// This file reads the generated fixture off disk, so it needs the Node
// globals the app config deliberately leaves out — browser code has no
// business with fs. Scoped here rather than widened in tsconfig.app.json.
// The generated campaign data, joined the way the page joins it.
//
// Unit tests pin the rules; this pins the actual bytes the dev server serves.
// The bug class it exists for is invisible to both a typecheck and a unit test:
// two files that are individually well-formed but do not join, so the page
// renders "nog niet geanalyseerd" over a complete set of verdicts.
//
// Skips when the fixtures are absent — they are generated and gitignored. A
// skipped test says "not checked"; a passing test over an empty array would say
// "checked and fine", which is worse than not running at all.
import { describe, expect, it } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { joinCampaign, campaignRollup, metricFor, stelzShare, SURFACES } from './campaign'
import { evidencedHandlesFor, matchEvent, inWindow } from './events'
import { getEvent, type StelzEvent } from '../data/events'
import type { CampaignItem } from './campaign'
import type { DetectionRow } from './types'

const TMP = resolve(__dirname, '../../../../../.tmp')
const ITEMS = resolve(TMP, 'preview-campaign.json')
const DETS = resolve(TMP, 'preview-campaign-detections.json')
const present = existsSync(ITEMS) && existsSync(DETS)
const read = <T>(p: string): T[] => JSON.parse(readFileSync(p, 'utf8')) as T[]

describe.skipIf(!present)('the generated campaign fixture', () => {
  const items = present ? read<CampaignItem>(ITEMS) : []
  const dets = present ? read<DetectionRow>(DETS) : []
  const rows = joinCampaign(items, dets)
  const rollup = campaignRollup(rows)

  it('joins every verdict onto its item', () => {
    expect(rows).toHaveLength(items.length)
    expect(rollup.judged).toBe(dets.length)
  })

  it('covers more than one platform', () => {
    // The entire point of the page. If this ever drops to one surface the
    // harvest silently stopped covering the other.
    const surfaces = new Set(rows.map((r) => r.surface))
    expect(surfaces.size).toBeGreaterThan(1)
    expect(rows.some((r) => r.platform === 'tiktok')).toBe(true)
    expect(rows.some((r) => r.platform === 'instagram')).toBe(true)
  })

  it('never gives a story a view count', () => {
    // Instagram publishes story views to the account holder and to nobody
    // else. A number here would have to have been invented.
    for (const r of rows.filter((r) => r.surface === 'story')) {
      expect(r.views, `story ${r.itemId} has a view count`).toBeNull()
    }
  })

  it('gives TikToks a real one', () => {
    const tt = rows.filter((r) => r.surface === 'tiktok')
    if (tt.length === 0) return
    expect(tt.some((r) => (r.views ?? 0) > 0)).toBe(true)
    expect(rollup.tiktokViews).toBeGreaterThan(0)
  })

  it('keeps the three metrics apart', () => {
    const perSurface = SURFACES.map((s) => rollup.bySurface[s].metric ?? 0)
    const sum = perSurface.reduce((a, b) => a + b, 0)
    // Nothing on the rollup equals the sum of all three — that number would be
    // a "total reach" describing plays, votes and likes as one thing.
    if (perSurface.filter((v) => v > 0).length > 1) {
      expect(Object.values(rollup).includes(sum)).toBe(false)
    }
  })

  it('resolves one person per row, not one account', () => {
    // Rein is @rvdofficial on Instagram and @rinnavandoffoe on TikTok. If the
    // identity map breaks, the roster of 28 reports 40-odd creators and the
    // "who delivered nothing" column stops meaning anything.
    const tiktokOnly = new Set(['rinnavandoffoe', 'pleun.bierbooms', 'isadeejans'])
    for (const r of rows) {
      expect(tiktokOnly.has(r.creatorHandle),
        `${r.creatorHandle} is a TikTok account, not a person`).toBe(false)
    }
  })

  it('serves its media from the archives, not from expiring CDN links', () => {
    const local = rows.filter((r) => (r.coverUrl ?? '').startsWith('/preview-media/'))
    expect(local.length).toBeGreaterThan(0)
  })

  it('gives every judged item the model\'s own description', () => {
    const judged = rows.filter((r) => r.verdict !== 'unanalysed')
    expect(judged.length).toBeGreaterThan(0)
    expect(judged.every((r) => (r.detection?.context ?? '').length > 5)).toBe(true)
  })

  it('reports images looked at, never fewer than items judged', () => {
    expect(rollup.imagesSeen).toBeGreaterThanOrEqual(rollup.judged)
    for (const r of rows) {
      if (r.verdict === 'unanalysed') expect(r.framesJudged).toBe(0)
      else expect(r.framesJudged).toBeGreaterThan(0)
    }
  })

  it('has a metric or an explicit blank for every row', () => {
    for (const r of rows) {
      const m = metricFor(r)
      expect(m === null || typeof m === 'number').toBe(true)
    }
  })
})

describe.skipIf(!present)('the roster / discovery split in the real fixture', () => {
  const items = present ? read<CampaignItem>(ITEMS) : []
  const dets = present ? read<DetectionRow>(DETS) : []
  const rows = joinCampaign(items, dets)
  const rollup = campaignRollup(rows)

  it('labels every row as one or the other', () => {
    for (const r of rows) {
      expect(['roster', 'discovery'], `${r.itemId} has source ${r.source}`)
        .toContain(r.source)
    }
  })

  it('never counts a booked account as organic pickup', () => {
    // 73_lowlands_discovery.py drops anything a BOOKED handle posted, whichever
    // hashtag surfaced it. If that check breaks, bought content starts being
    // reported as organic pickup — the single most flattering error this page
    // could make.
    //
    // Measured against the event definition, NOT against "every account that
    // appears on a roster row". Those are different sets, and the difference is
    // collab posts: Instagram publishes a collaboration on both authors'
    // profiles, so @stanlucas.m turns up as the platformHandle of a post
    // credited to @joshbram_ without ever having been booked. His own TikTok,
    // found via #lowlands, is genuinely organic — and an earlier version of
    // this test called that a violation.
    const booked = new Set<string>()
    for (const m of (getEvent('lowlands-2026') as StelzEvent).roster) {
      if (m.instagram) booked.add(m.instagram.toLowerCase())
      if (m.tiktok) booked.add(m.tiktok.toLowerCase())
    }
    for (const r of rows.filter((r) => r.source === 'discovery')) {
      const acct = (r.platformHandle ?? r.creatorHandle).toLowerCase()
      expect(booked.has(acct), `${acct} is booked and yet counted as organic`).toBe(false)
      expect(booked.has((r.creatorHandle ?? '').toLowerCase()),
        `${r.creatorHandle} is booked and yet counted as organic`).toBe(false)
    }
  })

  it('never puts one post on both sides of the split', () => {
    // The stricter half of the same worry, and the one that actually inflates a
    // number: a single post counted once as delivered and once as organic.
    // A co-author appearing in both sets is fine; a post doing so is not.
    const byId = new Map<string, string>()
    for (const r of rows) {
      const seen = byId.get(r.itemId)
      expect(seen === undefined || seen === r.source,
        `${r.itemId} is both ${seen} and ${r.source}`).toBe(true)
      byId.set(r.itemId, r.source)
    }
    const postSides = new Map<string, Set<string>>()
    for (const r of rows) {
      const set = postSides.get(r.postKey) ?? new Set<string>()
      set.add(r.source)
      postSides.set(r.postKey, set)
    }
    for (const [key, sides] of postSides) {
      expect([...sides], `${key} spans both sources`).toHaveLength(1)
    }
  })

  it('kan elke discovery-rij verantwoorden: een zoektag, of accountbewijs', () => {
    // Vroeger droeg élke discovery-rij zijn zoektag — discovery kón alleen uit
    // tagzoekopdrachten komen. Sinds de profielscrapes bestaat er een tweede
    // soort: de ongetagde rij van een account dat elders in het venster wél
    // een tag-match heeft. Die krijgt zijn foundVia ('profiel') pas op het
    // dashboard, van matchEvent. Wat NIET mag bestaan is een discovery-rij
    // zonder tag én zonder bewijs — die is op geen enkele manier aan het
    // evenement te verantwoorden.
    const disc = rows.filter((r) => r.source === 'discovery')
    if (disc.length === 0) return
    const ev = getEvent('lowlands-2026') as StelzEvent
    const evidenced = evidencedHandlesFor(ev, rows)
    const orphans = disc.filter((r) => {
      if ((r.foundVia ?? '').length > 0) return false
      const account = (r.platformHandle || r.creatorHandle || '').toLowerCase()
      return !evidenced.has(account)
    })
    // Wezen MOGEN in de fixture bestaan — de profielscrape van een getagde
    // vriend haalt ook diens niet-festivalposts binnen (@vara_gids is een
    // tv-gids; getagd wórden is geen bewijs dat je eigen feed Lowlands is).
    // Wat niet mag: dat zo'n rij het dashboard haalt. matchEvent moet elke
    // wees afwijzen, en dat is precies wat hier vastligt.
    for (const r of orphans) {
      expect(matchEvent(ev, r, evidenced), `${r.postKey} is een wees en telt toch mee`)
        .toBeNull()
    }
  })

  it('keeps the two view counts separate and adding up', () => {
    expect(rollup.bySource.roster.tiktokViews + rollup.bySource.discovery.tiktokViews)
      .toBe(rollup.tiktokViews)
  })
})

describe.skipIf(!present)('the event window and the roster, in the real fixture', () => {
  const items = present ? read<CampaignItem>(ITEMS) : []
  const dets = present ? read<DetectionRow>(DETS) : []
  const all = joinCampaign(items, dets)
  const ev = getEvent('lowlands-2026') as StelzEvent
  // The page's own attribution pass, applied here so the fixture is checked
  // against what a reader actually sees rather than what it happens to hold.
  const inEvent = all.flatMap((r) => {
    const m = matchEvent(ev, r)
    return m ? [{ ...r, source: m.source }] : []
  })
  const roster = new Set(ev.roster.map((m) => m.instagram.toLowerCase()))

  it('drops everything outside the period', () => {
    // The bug this exists for: no date filter anywhere, so a festival page
    // reported 50 sightings for a weekend that had 8, and fifteen of them were
    // from July.
    for (const r of inEvent) expect(inWindow(ev, r.postedAt)).toBe(true)
    expect(inEvent.length).toBeLessThan(all.length)
  })

  it('counts only in-window views', () => {
    // 100.928.763 was the number on screen; 1.167.605 fell inside the festival.
    // Eighty-six times over, in the flattering direction.
    const scoped = campaignRollup(inEvent)
    const everything = campaignRollup(all)
    expect(scoped.tiktokViews).toBeLessThanOrEqual(everything.tiktokViews)
    for (const r of inEvent.filter((r) => r.surface === 'tiktok')) {
      expect(inWindow(ev, r.postedAt)).toBe(true)
    }
  })

  it('credits every roster row to somebody on the roster', () => {
    // Collab posts arrive under a co-author's account — @golfnl, @bnnvara,
    // thirteen more. Left as themselves they became creators nobody booked and
    // the table reported 42 people for a roster of 28.
    for (const r of inEvent.filter((r) => r.source === 'roster')) {
      expect(roster.has(r.creatorHandle.toLowerCase()),
        `${r.creatorHandle} (posted by @${r.platformHandle}) is not on the roster`).toBe(true)
    }
  })

  it('never reports more creators than were booked', () => {
    const rollup = campaignRollup(inEvent.filter((r) => r.source === 'roster'), {}, [...roster])
    expect(rollup.creators.length).toBeLessThanOrEqual(ev.roster.length)
    expect(rollup.delivered).toBeLessThanOrEqual(rollup.rosterSize)
  })

  it('keeps discovery clear of the roster', () => {
    for (const r of inEvent.filter((r) => r.source === 'discovery')) {
      const acct = (r.platformHandle ?? r.creatorHandle).toLowerCase()
      expect(roster.has(acct), `${acct} is booked and counted as organic`).toBe(false)
    }
  })

  it('counts carousels as posts, not as slides', () => {
    const rollup = campaignRollup(inEvent)
    expect(rollup.posts).toBeLessThanOrEqual(rollup.items)
    expect(rollup.postsWithStelz).toBeLessThanOrEqual(rollup.posts)
    // The Instagram archive stores one row per slide, so if these are ever
    // equal the carousel grouping has stopped working.
    const igRows = inEvent.filter((r) => r.surface === 'post')
    if (igRows.some((r) => (r.slots ?? 1) > 1)) {
      expect(rollup.bySurface.post.posts).toBeLessThan(rollup.bySurface.post.items)
    }
  })

  it('stamps every row with the event that harvested it', () => {
    expect(items.every((i) => i.eventId === 'lowlands-2026')).toBe(true)
  })
})

describe.skipIf(!present)('an event with nothing in it', () => {
  it('reports blanks, not NaN or x/0', () => {
    const rollup = campaignRollup([], {}, [])
    expect(rollup.items).toBe(0)
    expect(rollup.posts).toBe(0)
    expect(rollup.rosterSize).toBe(0)
    expect(stelzShare(rollup)).toBeNull()      // not 0%, which claims we looked
    for (const s of SURFACES) {
      expect(rollup.bySurface[s].metric).toBeNull()
      expect(Number.isNaN(rollup.bySurface[s].posts)).toBe(false)
    }
  })

  it('does not invent silent creators for a set nobody booked', () => {
    const rollup = campaignRollup([], {}, [])
    expect(rollup.creators).toHaveLength(0)
    expect(rollup.silent).toBe(0)
  })
})

describe.skipIf(!present)('every surface brings the one figure it publishes', () => {
  const items = present ? read<CampaignItem>(ITEMS) : []
  const dets = present ? read<DetectionRow>(DETS) : []
  const rows = joinCampaign(items, dets)
  const rollup = campaignRollup(rows)

  it('carries story poll votes through to the page', () => {
    // 62 wrote eight fields per story and left the rest in the raw payload, so
    // this column was blank for months while the stories page — reading the
    // SAME payloads — showed 86,718 votes. A story publishes no view count at
    // all; poll votes are the only hard figure it produces, and a surface whose
    // one number never arrives looks like a surface that produced nothing.
    const stories = rows.filter((r) => r.surface === 'story')
    if (stories.length === 0) return
    expect(rollup.pollVotes).toBeGreaterThan(0)
    expect(rollup.bySurface.story.metric).toBe(rollup.pollVotes)
  })

  it('gives Instagram posts their likes', () => {
    const posts = rows.filter((r) => r.surface === 'post')
    if (posts.length === 0) return
    expect(rollup.postLikes).toBeGreaterThan(0)
    expect(posts.some((r) => (r.likes ?? 0) > 0)).toBe(true)
  })

  it('never lets one surface borrow another\'s metric', () => {
    for (const r of rows) {
      if (r.surface === 'story') {
        // Instagram shows story views to the account holder and nobody else.
        expect(r.views, `story ${r.itemId} has views`).toBeNull()
      }
      if (r.surface !== 'story') {
        expect(r.pollVotes, `${r.surface} ${r.itemId} has poll votes`).toBeFalsy()
      }
    }
  })

  it('keeps the three totals as three numbers', () => {
    // The one figure a client always asks for and that nothing here computes:
    // plays, likes and votes are three different events. If some field ever
    // equals their sum, a "total reach" has been invented.
    const sum = rollup.tiktokViews + rollup.postLikes + rollup.pollVotes
    const nonZero = [rollup.tiktokViews, rollup.postLikes, rollup.pollVotes]
      .filter((v) => v > 0).length
    if (nonZero > 1) {
      expect(Object.values(rollup).includes(sum)).toBe(false)
    }
  })

  it('splits TikTok views by who earned them and adds up', () => {
    // Paid delivery and organic pickup are worth different things. Kept apart
    // at every level, and the two halves must still account for the whole.
    expect(rollup.bySource.roster.tiktokViews + rollup.bySource.discovery.tiktokViews)
      .toBe(rollup.tiktokViews)
  })
})

// De kruisarchief-merge in 72_campaign_fixture.py. Dezelfde clip kwam via twee
// routes binnen — als tagvondst in het discovery-archief én via de
// profielscrape van de poster — en stond dus twee keer in de fixture: het
// trefferaantal telde dezelfde waarneming dubbel en de grid tekende twee
// identieke kaarten. In productie kan dat niet (één document per platform-id),
// dus de fixture moet het ook niet kunnen.
describe.skipIf(!present)('geen inhoud dubbel in de fixture', () => {
  const items = present ? read<CampaignItem>(ITEMS) : []

  it('bevat dezelfde dia of video nooit twee keer', () => {
    // Identiteit zoals 72 hem legt: account + shortcode + dia voor Instagram,
    // account + video-id voor TikTok. De id-TEKST verschilt per archief
    // (discovery zet "ig" voor IG-ids), dus die is geen identiteit.
    const seen = new Map<string, string>()
    for (const i of items) {
      if (i.surface === 'story') continue // stories staan maar in één archief
      const handle = (i.platformHandle || i.creatorHandle || '').toLowerCase()
      const key = i.surface === 'post'
        ? `ig/${handle}/${i.postKey}/${i.slot ?? ''}`
        : `tt/${handle}/${i.postKey}`
      const before = seen.get(key)
      expect(before, `${i.itemId} en ${before} zijn dezelfde inhoud, twee rijen`)
        .toBeUndefined()
      seen.set(key, i.itemId)
    }
  })

  it('behield bij het samenvoegen de zoektag én de cijfers', () => {
    // De twee kopieën verdelen de waarheid: de profielscrape draagt de likes,
    // de tagvondst draagt found_via — het bewijs waarop de accountregel
    // ongetagde posts laat meetellen. Gepind op een bekende samengevoegde dia;
    // op een fixture van een ander evenement bestaat die niet en zegt deze
    // test niets.
    const slide = items.find((i) => i.postKey === 'DcVc6PRDG0u' && i.slot === 12)
    if (!slide) return
    expect(slide.foundVia).toBe('lowlands2026')
    expect(slide.likes).not.toBeNull()
  })
})
