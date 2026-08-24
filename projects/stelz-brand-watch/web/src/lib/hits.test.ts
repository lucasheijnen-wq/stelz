// The rule this table cannot be allowed to break: a blank is not a zero.
//
// 22 of the 63 Lowlands sightings are Instagram stories, and Instagram tells
// nobody but the account holder how many people saw one. If those rows ever
// sort, export or render as 0, the dashboard is claiming a measurement it does
// not have — and doing it in the flattering direction is not better, because
// "22 stories reached nobody" is the reading a client will take away.

import { describe, expect, it } from 'vitest'
import {
  HIT_COLUMNS, hitValue, hitText, sortHits, stelzHits, metricLegend, liveColumns,
  hitTotals, bucketByRange, followerIndex,
} from './hits'
import { joinCampaign, type CampaignItem } from './campaign'
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
  confidence: 0.95, size_in_frame: 'large', is_primary_subject: true,
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

/** A TikTok with plays, an IG post with likes only, and a story with nothing —
 *  the three shapes the real archive actually contains. */
const mixed = () => joinCampaign([
  item({ itemId: 'tt', creatorHandle: 'anna', surface: 'tiktok', platform: 'tiktok',
         views: 194_300, likes: 7_674, comments: 31, shares: 1_663,
         postedAt: '2026-08-22T12:00:00Z' }),
  item({ itemId: 'ig', creatorHandle: 'bram', surface: 'post',
         likes: 2_179, comments: 43, postedAt: '2026-08-21T12:00:00Z' }),
  item({ itemId: 'st', creatorHandle: 'cato', surface: 'story',
         postedAt: '2026-08-20T12:00:00Z' }),
], [det({ post_id: 'tt' }), det({ post_id: 'ig' }), det({ post_id: 'st' })])

describe('een leeg vakje is geen nul', () => {
  it('geeft null terug waar het platform niets publiceert', () => {
    const [tt, ig, st] = mixed()
    expect(hitValue(tt, 'views')).toBe(194_300)
    expect(hitValue(ig, 'views')).toBeNull()      // fotopost, geen reel
    expect(hitValue(st, 'views')).toBeNull()      // story: alleen de accounthouder ziet dit
    expect(hitValue(st, 'likes')).toBeNull()
    expect(hitValue(ig, 'shares')).toBeNull()     // Instagram publiceert dit niet
  })

  it('onderscheidt een gemeten nul van een onbekende', () => {
    // TikTok meldt soms echt 0 keer gedeeld. Dat is een meting, en die mag niet
    // op één hoop met een story die nooit geteld is.
    const [row] = joinCampaign(
      [item({ itemId: 'z', creatorHandle: 'anna', surface: 'tiktok', platform: 'tiktok', shares: 0 })],
      [det({ post_id: 'z' })],
    )
    expect(hitValue(row, 'shares')).toBe(0)
    expect(hitText(row, 'shares')).toBe('0')
  })

  it('toont een streepje, nooit een 0, voor wat niet gepubliceerd wordt', () => {
    const [, , st] = mixed()
    for (const key of ['views', 'likes', 'comments', 'shares'] as const) {
      expect(hitText(st, key)).toBe('—')
    }
  })
})

describe('sorteren', () => {
  it('houdt lege waarden onderaan in BEIDE richtingen', () => {
    // De hele reden dat dit getest wordt: oplopend sorteren op weergaven mag de
    // 22 onmeetbare stories niet bovenaan zetten alsof ze het slechtst scoorden.
    const rows = mixed()
    expect(sortHits(rows, 'views', 'asc').map((r) => r.itemId)).toEqual(['tt', 'ig', 'st'])
    expect(sortHits(rows, 'views', 'desc').map((r) => r.itemId)).toEqual(['tt', 'ig', 'st'])
  })

  it('sorteert getallen als getallen, niet als tekst', () => {
    const rows = joinCampaign([
      item({ itemId: 'klein', creatorHandle: 'a', surface: 'tiktok', platform: 'tiktok', views: 9 }),
      item({ itemId: 'groot', creatorHandle: 'b', surface: 'tiktok', platform: 'tiktok', views: 10_000 }),
    ], [det({ post_id: 'klein' }), det({ post_id: 'groot' })])
    expect(sortHits(rows, 'views', 'desc').map((r) => r.itemId)).toEqual(['groot', 'klein'])
  })

  it('breekt gelijkspel altijd hetzelfde, ongeacht de invoervolgorde', () => {
    const rows = joinCampaign([
      item({ itemId: 'b', creatorHandle: 'x', surface: 'story', postedAt: '2026-08-20T09:00:00Z' }),
      item({ itemId: 'a', creatorHandle: 'x', surface: 'story', postedAt: '2026-08-20T09:00:00Z' }),
    ], [det({ post_id: 'a' }), det({ post_id: 'b' })])
    const forward = sortHits(rows, 'handle', 'asc').map((r) => r.itemId)
    const backward = sortHits([...rows].reverse(), 'handle', 'asc').map((r) => r.itemId)
    expect(forward).toEqual(backward)
  })

  it('laat de invoer met rust', () => {
    const rows = mixed()
    const before = rows.map((r) => r.itemId)
    sortHits(rows, 'views', 'asc')
    expect(rows.map((r) => r.itemId)).toEqual(before)
  })
})

describe('welke rijen in de tabel horen', () => {
  it('neemt alleen treffers, niet de bijna-treffers', () => {
    const rows = joinCampaign([
      item({ itemId: 'hit', creatorHandle: 'a' }),
      item({ itemId: 'mis', creatorHandle: 'b' }),
      item({ itemId: 'bijna', creatorHandle: 'c' }),
    ], [
      det({ post_id: 'hit' }),
      det({ post_id: 'mis', detected: false }),
      det({ post_id: 'bijna', detected: false, gate: 'size' }),
    ])
    expect(stelzHits(rows).map((r) => r.itemId)).toEqual(['hit'])
  })

  it('telt een klein blikje wel mee', () => {
    // `small` is een echte treffer die de maatpoort degradeerde. Weglaten zou
    // de campagne te laag rapporteren; als "goed zichtbaar" tonen te hoog.
    const rows = joinCampaign(
      [item({ itemId: 's', creatorHandle: 'a' })],
      [det({ post_id: 's', size_in_frame: 'small', is_primary_subject: false, confidence: 0.75 })],
    )
    expect(stelzHits(rows)).toHaveLength(1)
    expect(hitValue(rows[0], 'visibility')).toBe('klein')
  })
})

describe('de kopcijfers', () => {
  it('telt nooit twee vlakken bij elkaar op', () => {
    // De regel waar lib/campaign.ts grotendeels voor bestaat, hier opnieuw:
    // 194.300 afspelingen + 2.179 likes is geen 196.479 van iets.
    const t = hitTotals(stelzHits(mixed()))
    expect(t.tiktokViews).toBe(194_300)
    expect(t.postLikes).toBe(2_179)
    expect(t.tiktokVideos).toBe(1)
    expect(t.likedPosts).toBe(1)
    expect(t.storyHits).toBe(1)
    expect(Object.values(t)).not.toContain(196_479)
  })

  it('ontdubbelt een carrousel tot één post', () => {
    // Het blikje staat op dia 3 en dia 7: twee waarnemingen, één post.
    const rows = joinCampaign([
      item({ itemId: 'c3', creatorHandle: 'anna', platformHandle: 'anna', postKey: 'ABC', slot: 2, slots: 8 }),
      item({ itemId: 'c7', creatorHandle: 'anna', platformHandle: 'anna', postKey: 'ABC', slot: 6, slots: 8 }),
    ], [det({ post_id: 'c3' }), det({ post_id: 'c7' })])
    const t = hitTotals(stelzHits(rows))
    expect(t.hits).toBe(2)
    expect(t.posts).toBe(1)
    expect(t.accounts).toBe(1)
  })

  it('rekent de cijfers van een carrousel één keer, niet één keer per dia', () => {
    // DE ECHTE FOUT, met de echte cijfers. Het blikje stond op vijf dia's van
    // @sterredegoedex' carrousel; elke dia draagt hetzelfde post-getal van 2.179
    // likes, want dat is het enige likegetal dat de post heeft. Per rij optellen
    // maakte er 10.895 van, en over alle treffers 48.919 waar 38.758 waar was.
    const slide = (n: number) => item({
      itemId: `s${n}`, creatorHandle: 'sterredegoedex', platformHandle: 'sterredegoedex',
      postKey: 'DcV-Z_SDRwM', slot: n, slots: 10,
      surface: 'post', platform: 'instagram', likes: 2_179, comments: 31,
    })
    const rows = joinCampaign(
      [1, 2, 3, 4, 5].map(slide),
      [1, 2, 3, 4, 5].map((n) => det({ post_id: `s${n}` })),
    )
    const t = hitTotals(stelzHits(rows))
    expect(t.hits).toBe(5)
    expect(t.posts).toBe(1)
    expect(t.likes).toBe(2_179)
    expect(t.comments).toBe(31)
    // De dekking telt posts, niet dia's — anders deelt de tegel een getal per
    // post door een aantal dia's.
    expect(t.likedOn).toBe(1)
    expect(t.commentedOn).toBe(1)
    expect(Object.values(t)).not.toContain(10_895)
  })

  it('noemt wie geen volgersaantal prijsgeeft in plaats van hem als 0 te tellen', () => {
    const tt = { surface: 'tiktok', platform: 'tiktok' } as const
    const rows = joinCampaign([
      item({ itemId: 'a', creatorHandle: 'anna', platformHandle: 'anna', ...tt }),
      item({ itemId: 'b', creatorHandle: 'stil', platformHandle: 'stil', ...tt }),
    ], [
      det({ post_id: 'a', follower_count: 50_000 }),
      det({ post_id: 'b', follower_count: null }),
    ])
    const t = hitTotals(stelzHits(rows))
    expect(t.tiktokFollowers).toBe(50_000)
    expect(t.tiktokFollowersKnownFor).toBe(1)
    expect(t.tiktokAccounts).toBe(2)
    expect(t.tiktokAccountsWithoutFollowers).toEqual(['stil'])
  })

  it('telt een Instagram-account niet als TikTok-account zonder volgers', () => {
    // Instagram levert bij deze scrape NUL volgersaantallen — 0 van 1534 rijen.
    // Elk IG-account in de "onbekend"-lijst zetten maakt die lijst even lang als
    // de campagne en dus betekenisloos; het cijfer heet daarom TikTok-volgers.
    const t = hitTotals(stelzHits(joinCampaign(
      [item({ itemId: 'ig', creatorHandle: 'anna', platformHandle: 'anna', surface: 'post' })],
      [det({ post_id: 'ig', follower_count: null })],
    )))
    expect(t.accounts).toBe(1)
    expect(t.tiktokAccounts).toBe(0)
    expect(t.tiktokAccountsWithoutFollowers).toEqual([])
  })

  it('vindt een volgersaantal ook als alleen een MIS-rij het draagt', () => {
    // Het echte geval: van de 108 detecties op een treffer dragen er 37 een
    // volgersaantal, terwijl dezelfde accounts er wél een hebben op een van hun
    // andere rijen. Alleen naar de treffers kijken zette negentien accounts op
    // "onbekend" en gaf een publiek dat drie keer te klein was.
    const alles = joinCampaign([
      item({ itemId: 'hit', creatorHandle: 'anna', platformHandle: 'anna', surface: 'tiktok', platform: 'tiktok' }),
      item({ itemId: 'mis', creatorHandle: 'anna', platformHandle: 'anna', surface: 'tiktok', platform: 'tiktok' }),
    ], [
      det({ post_id: 'hit', follower_count: null }),
      det({ post_id: 'mis', detected: false, follower_count: 89_400 }),
    ])
    const hits = stelzHits(alles)
    expect(hitTotals(hits).tiktokFollowersKnownFor).toBe(0)         // alleen treffers: kwijt
    expect(hitTotals(hits, followerIndex(alles)).tiktokFollowers).toBe(89_400)
  })

  it('geeft de volgers van een co-auteur niet aan de geboekte creator', () => {
    // Bij een samenwerkingspost is platformHandle het account van de co-auteur.
    // Diens volgersaantal op de geboekte creator plakken blaast precies het
    // getal op waar dit bestand voorzichtig mee is.
    const idx = followerIndex(joinCampaign(
      [item({ itemId: 'collab', creatorHandle: 'joshbram_', platformHandle: 'stanlucas.m' })],
      [det({ post_id: 'collab', follower_count: 12_000 })],
    ))
    expect(idx.get('stanlucas.m')).toBe(12_000)
    expect(idx.get('joshbram_')).toBeUndefined()
  })

  it('laat een onbekend cijfer buiten de som, niet als nul erin', () => {
    const rows = joinCampaign([
      item({ itemId: 'x', creatorHandle: 'a', surface: 'tiktok', platform: 'tiktok', views: 100 }),
      item({ itemId: 'y', creatorHandle: 'b', surface: 'tiktok', platform: 'tiktok', views: null }),
    ], [det({ post_id: 'x' }), det({ post_id: 'y' })])
    const t = hitTotals(stelzHits(rows))
    expect(t.tiktokViews).toBe(100)
    expect(t.tiktokVideos).toBe(1)   // niet 2 — de tweede is niet geteld
  })
})

describe('dagverdeling over het evenementvenster', () => {
  it('gebruikt de periode van het evenement, niet de laatste N dagen', () => {
    // bucketByDay telt terug vanaf vandaag; open Lowlands in oktober en elke
    // balk is leeg. Een evenement heeft zijn periode opgeschreven staan.
    const days = bucketByRange(
      ['2026-08-18T10:00:00Z', '2026-08-18T23:00:00Z', '2026-08-20T10:00:00Z'],
      '2026-08-17', '2026-08-21',
    )
    expect(days.map((d) => d.d)).toEqual([
      '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20', '2026-08-21',
    ])
    expect(days.map((d) => d.n)).toEqual([0, 2, 0, 1, 0])
  })

  it('negeert wat buiten de periode valt in plaats van het op de rand te stapelen', () => {
    const days = bucketByRange(['2026-07-01T10:00:00Z', null, undefined], '2026-08-17', '2026-08-18')
    expect(days.map((d) => d.n)).toEqual([0, 0])
  })
})

describe('de legenda en de kolommen', () => {
  it('beschrijft elk vlak vanuit dezelfde kolomtabel', () => {
    const legend = metricLegend()
    const tiktok = legend.find((l) => l.surface === 'tiktok')!
    const story = legend.find((l) => l.surface === 'story')!
    expect(tiktok.missing).toEqual([])           // TikTok publiceert alles
    expect(story.has).toEqual([])                // en een story helemaal niets
    expect(story.missing.length).toBeGreaterThan(0)
  })

  it('laat een kolom vallen die in deze selectie nergens een getal heeft', () => {
    const alleenStories = joinCampaign(
      [item({ itemId: 's1', creatorHandle: 'a' }), item({ itemId: 's2', creatorHandle: 'b' })],
      [det({ post_id: 's1' }), det({ post_id: 's2' })],
    )
    const keys = liveColumns(alleenStories).map((c) => c.key)
    expect(keys).not.toContain('views')
    expect(keys).not.toContain('shares')
    expect(keys).not.toContain('slide')          // niets hier is een carrousel
    expect(keys).toContain('handle')             // niet-numerieke kolommen blijven
    expect(keys).toContain('visibility')
  })

  it('noemt de dia zodra er een carrousel in beeld is', () => {
    // Zonder deze kolom staan er vijf rijen met precies dezelfde 2.179 likes en
    // niets dat zegt dat het één post is. In het bestand dat de klant opent is
    // dat het verschil tussen kloppen en 147% ernaast zitten.
    const rows = joinCampaign([
      item({ itemId: 'c1', creatorHandle: 'a', platformHandle: 'a', postKey: 'ABC',
             slot: 2, slots: 10, surface: 'post', likes: 2_179 }),
      item({ itemId: 'c2', creatorHandle: 'a', platformHandle: 'a', postKey: 'ABC',
             slot: 6, slots: 10, surface: 'post', likes: 2_179 }),
    ], [det({ post_id: 'c1' }), det({ post_id: 'c2' })])

    expect(liveColumns(rows).map((c) => c.key)).toContain('slide')
    expect(hitValue(rows[0], 'slide')).toBe('3/10')   // slot is 0-gebaseerd
    expect(hitValue(rows[1], 'slide')).toBe('7/10')
  })

  it('laat de dia leeg voor alles wat geen carrousel is', () => {
    // "1/1" op een TikTok zou suggereren dat er meer dia's konden zijn.
    const tt = joinCampaign(
      [item({ itemId: 't', creatorHandle: 'a', surface: 'tiktok', slot: 0, slots: 1 })],
      [det({ post_id: 't' })])
    expect(hitValue(tt[0], 'slide')).toBeNull()
    expect(hitText(tt[0], 'slide')).toBe('—')
  })

  it('houdt elke kolom sorteerbaar', () => {
    const rows = mixed()
    for (const c of HIT_COLUMNS) {
      expect(() => sortHits(rows, c.key, 'asc')).not.toThrow()
      expect(sortHits(rows, c.key, 'asc')).toHaveLength(rows.length)
    }
  })
})
