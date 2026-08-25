// The audience layer — and mostly, the denominators under it.
//
// The number this tab exists to produce is "154 of 2.040 people commented on
// more than one booked creator". Both halves are load-bearing: 154 alone is a
// number someone will read as large, and a percentage alone is one nobody can
// check. Every assertion here is about keeping the pair together.

import { describe, expect, it } from 'vitest'
import { overlap, reachBands, leadShare, stelzShareOf, type Audience, type AccountStats } from './audience'

const stats = (over: Partial<AccountStats> = {}): AccountStats => ({
  accounts: 0, followersKnownFor: 0, medianFollowers: null,
  totalFollowers: 0, verified: 0, withStelz: 0, withBio: 0, withAge: 0, ...over,
})

const audience = (over: Partial<Audience['commenters']> = {}): Audience => ({
  eventId: 'lowlands-2026',
  commenters: {
    top: [], people: 2040, comments: 2854, postsWithComments: 218,
    shared: 154, listed: 60,
    reachDistribution: { 1: 1886, 2: 102, 3: 30, 4: 13, 5: 4, 6: 3, 7: 1, 11: 1 },
    ...over,
  },
  tagged: { top: [], accounts: 392, onRoster: 22, tags: 0, listed: 60 },
  accounts: { top: [], roster: stats(), discovery: stats(), listed: 60, total: 361 },
  context: {
    languages: [], languagesKnownFor: 0, languagePosts: 0,
    sounds: [], soundsKnownFor: 0, soundsDistinct: 0,
    places: [], placesKnownFor: 0, placePosts: 0,
  },
})

describe('het gedeelde publiek', () => {
  it('geeft het aandeel mét zijn noemer terug', () => {
    // 7,5% is niet controleerbaar; "154 van 2.040" wel. Beide, altijd.
    const o = overlap(audience())
    expect(o.shared).toBe(154)
    expect(o.people).toBe(2040)
    expect(o.pct).toBeCloseTo(7.55, 1)
  })

  it('deelt niet door nul als er nog niemand gereageerd heeft', () => {
    expect(overlap(audience({ people: 0, shared: 0 })).pct).toBe(0)
  })

  it('houdt de grijze meerderheid in de verdeling', () => {
    // 1.886 van de 2.040 reageerden op precies één creator. Die rij weglaten
    // zou de 154 het hele verhaal laten lijken in plaats van 7,5% ervan.
    const bands = reachBands(audience())
    expect(bands.map((b) => b.reached)).toEqual([11, 7, 6, 5, 4, 3, 2, 1])
    expect(bands.at(-1)).toEqual({ reached: 1, people: 1886 })
    expect(bands.reduce((s, b) => s + b.people, 0)).toBe(2040)
  })

  it('telt precies de mensen die 2+ creators bereiken als gedeeld', () => {
    const bands = reachBands(audience())
    const shared = bands.filter((b) => b.reached >= 2).reduce((s, b) => s + b.people, 0)
    expect(shared).toBe(audience().commenters.shared)
  })
})

describe('ranglijsten zonder noemer bestaan niet', () => {
  it('geeft het aandeel van de koploper tegen wat het veld droeg', () => {
    expect(leadShare([{ label: 'nl', count: 726 }], 1150)).toBeCloseTo(63.1, 1)
  })

  it('geeft null in plaats van 0% als niemand het veld meegaf', () => {
    // 0% claimt een meting. Null zegt "niet meegegeven", en dat is het verschil
    // tussen "niemand sprak Nederlands" en "geen enkele post gaf een taal mee".
    expect(leadShare([{ label: 'nl', count: 5 }], 0)).toBeNull()
    expect(leadShare([], 100)).toBeNull()
  })

  it('komt nooit boven 100% uit, want dat verraadt de verkeerde noemer', () => {
    // Dit is de bug die de sounds-kaart had: de teller telde POSTS, de noemer
    // telde UNIEKE SOUNDS. Beide getallen klopten, hun deling sloeg nergens op.
    // Zolang de noemer de juiste eenheid heeft kan de koploper er niet boven.
    const rows = [{ label: 'origineel geluid', count: 480 }]
    expect(leadShare(rows, 900)!).toBeLessThanOrEqual(100)
    // Met de verkeerde noemer (311 unieke sounds) zou dit 154% zijn geweest.
    expect(leadShare(rows, 311)!).toBeGreaterThan(100)
  })
})

describe('accounts met Stëlz in beeld', () => {
  it('zet de treffers af tegen de groep waar ze uit komen', () => {
    // 26 van 337 festivalgangers is een heel ander verhaal dan 26 van 30, en
    // het losse getal 26 leest als het tweede.
    expect(stelzShareOf(stats({ accounts: 337, withStelz: 26 }))).toBeCloseTo(7.7, 1)
  })

  it('geeft null voor een lege groep in plaats van 0%', () => {
    expect(stelzShareOf(stats())).toBeNull()
  })
})
