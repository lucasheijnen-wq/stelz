// The rules attribution cannot be allowed to break.
//
// Two of these guard bugs that were live on the real fixture and both leaned
// the same way — towards a bigger number:
//
//   the window       50 sightings shown for a festival that had 8, and
//                    100.928.763 TikTok views where 1.167.605 fell in period.
//   the collab rule  44 rows from 15 accounts that look like strangers but are
//                    co-authored roster posts. Filed as discovery they turn
//                    bought reach into organic reach.
import { describe, expect, it } from 'vitest'
import {
  matchEvent, evidencedHandlesFor, eventWindow, inWindow, eventStatus, rosterAccounts, identityMap,
  nameMap, orderedTags, formatWindow, bookingFor, type Attributable,
} from './events'
import { EVENTS, getEvent, type StelzEvent } from '../data/events'

const LL = getEvent('lowlands-2026') as StelzEvent

const item = (over: Attributable): Attributable => ({
  postedAt: '2026-08-21T12:00:00Z', ...over,
})

describe('the event definition', () => {
  it('is the roster the import screen expects', () => {
    // 28 people, 53 platform ids — the same two numbers importList.test.ts
    // asserts about the seed text. If a transcription slips, both fail.
    expect(LL.roster).toHaveLength(28)
    const ids = LL.roster.flatMap((m) => [m.instagram, m.tiktok].filter(Boolean))
    expect(ids).toHaveLength(53)
  })

  it('says null, not "Geen", for people with no TikTok', () => {
    // Three real people, not a parse failure. A scraper that asks Apify for a
    // profile called "geen" spends money to be told it does not exist.
    const none = LL.roster.filter((m) => m.tiktok === null)
    expect(none).toHaveLength(3)
    expect(LL.roster.some((m) => String(m.tiktok).toLowerCase() === 'geen')).toBe(false)
  })

  it('gives every event a distinct id', () => {
    expect(new Set(EVENTS.map((e) => e.id)).size).toBe(EVENTS.length)
  })

  it('never lets an event end before it starts', () => {
    for (const e of EVENTS) {
      expect(e.window.end >= e.window.start).toBe(true)
      const w = eventWindow(e)
      expect(w.end >= w.start).toBe(true)
    }
  })
})

describe('the window', () => {
  it('is the festival plus its run-up and its tail', () => {
    // 20–23 aug, 3 days before and 7 after. People post the packing video days
    // out and the recap a week later; both are the event a brand bought.
    expect(eventWindow(LL)).toEqual({ start: '2026-08-17', end: '2026-08-30' })
  })

  it('includes both ends', () => {
    expect(inWindow(LL, '2026-08-17T00:00:00Z')).toBe(true)
    expect(inWindow(LL, '2026-08-30T23:59:59Z')).toBe(true)
    expect(inWindow(LL, '2026-08-16T23:59:59Z')).toBe(false)
    expect(inWindow(LL, '2026-08-31T00:00:01Z')).toBe(false)
  })

  it('crosses a month boundary without arithmetic damage', () => {
    const nye: StelzEvent = {
      ...LL, id: 'x', window: { start: '2025-12-30', end: '2026-01-02', preDays: 3, postDays: 7 },
    }
    expect(eventWindow(nye)).toEqual({ start: '2025-12-27', end: '2026-01-09' })
  })

  it('keeps out July', () => {
    // 15 of the 50 sightings on the real fixture were from July. They are real
    // detections and they are not Lowlands.
    expect(inWindow(LL, '2026-07-14T09:00:00Z')).toBe(false)
  })

  it('treats a missing timestamp as outside, not as inside', () => {
    expect(inWindow(LL, null)).toBe(false)
    expect(inWindow(LL, '')).toBe(false)
    expect(inWindow(LL, undefined)).toBe(false)
  })

  it('reads as a date range a human would write', () => {
    expect(formatWindow(LL)).toBe('17 – 30 aug')
  })

  it('knows whether the event has happened yet', () => {
    expect(eventStatus(LL, '2026-08-18')).toBe('aankomend')
    expect(eventStatus(LL, '2026-08-21')).toBe('live')
    expect(eventStatus(LL, '2026-08-24')).toBe('afgelopen')
  })
})

describe('the roster', () => {
  it('holds both platforms', () => {
    const set = rosterAccounts(LL)
    expect(set.has('rvdofficial')).toBe(true)
    expect(set.has('rinnavandoffoe')).toBe(true)
    expect(set.size).toBe(41)   // 53 ids, 12 of which are the same word twice
  })

  it('maps a TikTok name back to the person', () => {
    // Keyed on the account, Rein is two creators and a roster of 28 reports 42.
    expect(identityMap(LL).get('rinnavandoffoe')).toBe('rvdofficial')
    expect(nameMap(LL).get('rinnavandoffoe')).toBe('Rein van Duivenboden')
    expect(nameMap(LL).get('rvdofficial')).toBe('Rein van Duivenboden')
  })
})

describe('matchEvent', () => {
  it('files a roster creator as roster', () => {
    expect(matchEvent(LL, item({ creatorHandle: 'brittmessing' })))
      .toEqual({ eventId: 'lowlands-2026', source: 'roster', foundVia: null })
  })

  it('files a collab post as roster, credited through the profile it was found on', () => {
    // @golfnl is not on the roster. Apify found this post while reading Britt
    // Messing's profile, because she is a co-author. All 45 such rows resolve.
    expect(matchEvent(LL, item({ platformHandle: 'golfnl', scrapedFor: 'brittmessing' })))
      .toEqual({ eventId: 'lowlands-2026', source: 'roster', foundVia: null })
  })

  it('files a stranger with a matching tag as discovery', () => {
    expect(matchEvent(LL, item({ platformHandle: 'iemandanders', hashtags: ['lowlands'] })))
      .toEqual({ eventId: 'lowlands-2026', source: 'discovery', foundVia: 'lowlands' })
  })

  it('credits the most specific tag, not the biggest one', () => {
    // #lowlands returns the whole festival; #stelzlowlands says why this post
    // was worth finding. Brand family is ordered first for exactly this.
    const m = matchEvent(LL, item({
      platformHandle: 'iemandanders', hashtags: ['lowlands', 'stelzlowlands', 'festival'],
    }))
    expect(m?.foundVia).toBe('stelzlowlands')
  })

  it('ignores the # and the capitals a caption actually carries', () => {
    const m = matchEvent(LL, item({ platformHandle: 'iemandanders', hashtags: ['#LowLands'] }))
    expect(m?.source).toBe('discovery')
  })

  it('rejects everything outside the window, roster included', () => {
    // The rule that had to come first. In July a roster creator is posting, but
    // not about this festival.
    expect(matchEvent(LL, item({ creatorHandle: 'brittmessing', postedAt: '2026-07-14T09:00:00Z' })))
      .toBeNull()
    expect(matchEvent(LL, item({ platformHandle: 'x', hashtags: ['lowlands'], postedAt: '2025-08-20T09:00:00Z' })))
      .toBeNull()
  })

  it('rejects a stranger with no matching tag', () => {
    expect(matchEvent(LL, item({ platformHandle: 'iemandanders', hashtags: ['tomorrowland'] })))
      .toBeNull()
    expect(matchEvent(LL, item({ platformHandle: 'iemandanders' }))).toBeNull()
  })

  it('keeps an undated roster post but drops an undated hashtag find', () => {
    // Asymmetric on purpose. An undated roster post is at worst filed under the
    // wrong event of the same creator's; an undated hashtag hit is an open
    // invitation for last year's festival to inflate the organic column.
    expect(matchEvent(LL, { creatorHandle: 'brittmessing', postedAt: null })?.source).toBe('roster')
    expect(matchEvent(LL, { platformHandle: 'vreemde', hashtags: ['lowlands'], postedAt: null }))
      .toBeNull()
  })

  it('normalises the @ and the capitals on a handle', () => {
    expect(matchEvent(LL, item({ creatorHandle: '@BrittMessing' }))?.source).toBe('roster')
  })

  it('puts brand tags before event tags', () => {
    const ordered = orderedTags(LL)
    const lastBrand = Math.max(...LL.hashtags.filter((h) => h.family === 'brand')
      .map((h) => ordered.indexOf(h.tag)))
    const firstEvent = Math.min(...LL.hashtags.filter((h) => h.family === 'event')
      .map((h) => ordered.indexOf(h.tag)))
    expect(lastBrand).toBeLessThan(firstEvent)
  })
})

describe('account evidence: één getagde clip bewijst het weekend', () => {
  // Een festivalganger tagt #lowlands op één clip en niet op de andere vier
  // van dezelfde camping. De getagde bewijst het weekend; de ongetagde rijden
  // op dat bewijs mee — maar alléén binnen het venster, en alléén als de
  // aanroeper de bewijsset meegeeft.
  const tagged = item({ platformHandle: 'camperaar', hashtags: ['lowlands'] })
  const untagged = item({ platformHandle: 'camperaar', hashtags: ['ochtendkoffie'] })

  it('telt een ongetagde in-venster post van een bewezen account als discovery', () => {
    const evidence = evidencedHandlesFor(LL, [tagged, untagged])
    expect(evidence.has('camperaar')).toBe(true)
    expect(matchEvent(LL, untagged, evidence))
      .toEqual({ eventId: 'lowlands-2026', source: 'discovery', foundVia: 'profiel' })
  })

  it('verandert NIETS zonder bewijsset — het oude gedrag is de default', () => {
    expect(matchEvent(LL, untagged)).toBeNull()
  })

  it('laat de tag op een getagde post winnen van het accountbewijs', () => {
    // 'profiel' zou verhullen hoe de rij gevonden is; de tag is specifieker.
    const evidence = evidencedHandlesFor(LL, [tagged, untagged])
    expect(matchEvent(LL, tagged, evidence)?.foundVia).toBe('lowlands')
  })

  it('trekt geen oude content binnen: het venster blijft eerst', () => {
    const evidence = evidencedHandlesFor(LL, [tagged])
    expect(matchEvent(LL, { ...untagged, postedAt: '2025-08-21T12:00:00Z' }, evidence))
      .toBeNull()
    expect(matchEvent(LL, { ...untagged, postedAt: null }, evidence)).toBeNull()
  })

  it('geeft geen bewijs op een post die buiten het venster ligt', () => {
    // De getagde clip is van vorig jaar: geen bewijs voor dít evenement.
    const oldTagged = { ...tagged, postedAt: '2025-08-21T12:00:00Z' }
    expect(evidencedHandlesFor(LL, [oldTagged, untagged]).size).toBe(0)
  })

  it('geeft rosterleden geen bewijsstatus — die zijn al roster', () => {
    const rosterTagged = item({ creatorHandle: 'brittmessing', hashtags: ['lowlands'] })
    expect(evidencedHandlesFor(LL, [rosterTagged]).size).toBe(0)
  })

  it('accepteert de vastgelegde zoektag als bewijs, ook zonder caption-tag', () => {
    // 82 van 176 discovery-rijen dragen geen event-tag in hun caption; de
    // harvest legde de zoektag vast in foundVia. Dat is bewijs.
    const viaSearch = item({ platformHandle: 'camperaar', foundVia: 'lowlands2026' })
    expect(evidencedHandlesFor(LL, [viaSearch]).has('camperaar')).toBe(true)
  })

  it("gebruikt 'profiel' zelf nooit als bewijs — bewijs mag niet composteren", () => {
    // Anders wordt de uitvoer van ronde 1 het bewijs van ronde 2, en groeit de
    // set zonder dat er ooit een echte tag aan te pas kwam.
    const viaProfile = item({ platformHandle: 'camperaar', foundVia: 'profiel' })
    expect(evidencedHandlesFor(LL, [viaProfile]).size).toBe(0)
  })
})

describe('foundVia, the tag the harvest actually searched', () => {
  const item = (over: Attributable): Attributable => ({
    postedAt: '2026-08-21T12:00:00Z', platformHandle: 'vreemde', ...over,
  })

  it('keeps a find whose caption never repeated the tag', () => {
    // 82 of 176 archived discovery rows are like this. Some are TikTok's search
    // being fuzzy, some are real festival content with a bare caption — and the
    // caption alone cannot tell them apart, so both are kept and both land in
    // the denominator.
    const m = matchEvent(LL, item({ foundVia: 'lowlands2026', hashtags: [] }))
    expect(m).toEqual({ eventId: 'lowlands-2026', source: 'discovery', foundVia: 'lowlands2026' })
  })

  it('still rejects a tag this event never searched for', () => {
    // foundVia is trusted, not obeyed. A row harvested for another event does
    // not become this one's because it carries a tag.
    expect(matchEvent(LL, item({ foundVia: 'tomorrowland', hashtags: [] }))).toBeNull()
  })

  it('does not let foundVia smuggle a row past the window', () => {
    expect(matchEvent(LL, item({ foundVia: 'stelz', postedAt: '2025-08-20T12:00:00Z' })))
      .toBeNull()
  })

  it('never overrides the roster', () => {
    // A roster creator's post found by hashtag is still a delivery. Paid reach
    // must not cross into the organic column.
    const m = matchEvent(LL, item({ platformHandle: 'brittmessing', foundVia: 'stelz' }))
    expect(m?.source).toBe('roster')
    expect(m?.foundVia).toBeNull()
  })

  it('falls back to the caption when nothing was recorded', () => {
    expect(matchEvent(LL, item({ hashtags: ['lowlands'] }))?.foundVia).toBe('lowlands')
  })
})

describe('bookingFor', () => {
  it('finds a booked creator by either platform', () => {
    // Het roster boekt een PERSOON. Rein heet @rvdofficial op Instagram en
    // @rinnavandoffoe op TikTok; beide moeten dezelfde boeking opleveren.
    const withTikTok = LL.roster.find((m) => m.tiktok)!
    expect(bookingFor(withTikTok.instagram)?.member.name).toBe(withTikTok.name)
    expect(bookingFor(withTikTok.tiktok as string)?.member.name).toBe(withTikTok.name)
  })

  it('ignores case and a leading @', () => {
    const m = LL.roster[0]
    expect(bookingFor(`@${m.instagram.toUpperCase()}`)?.member.name).toBe(m.name)
  })

  it('returns null for someone nobody booked', () => {
    // De helft van het punt: zonder dit onderscheid leest "geen detecties voor
    // @davidscholten" hetzelfde als "@davidscholten plaatste niets", en dat is
    // het verschil tussen een gat in de tool en de bevinding zelf.
    expect(bookingFor('een-vreemde-van-het-internet')).toBeNull()
    expect(bookingFor('')).toBeNull()
  })

  it('names the event, so the page can say which one', () => {
    expect(bookingFor(LL.roster[0].instagram)?.event.id).toBe(LL.id)
  })
})
