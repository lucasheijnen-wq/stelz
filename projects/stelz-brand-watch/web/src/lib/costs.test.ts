// Money on screen. The parity with the backend table is asserted in Python
// (firebase/functions/tests/test_cost_parity.py, which reads costs.ts as text);
// what is asserted here is that the arithmetic on top of it is right.
import { describe, expect, it } from 'vitest'
import {
  COST_PER_UNIT, UNIT_META, VOLUME_COUNTERS,
  spendBreakdown, degradeLevel, DEGRADE_LABEL,
  storySweepCost, creatorScanCost, hashtagScanCost,
  recipes, projection, fmtUsd, DEFAULTS,
} from './costs'

describe('spendBreakdown', () => {
  it('is zero, not NaN, for a day with no counters', () => {
    const out = spendBreakdown({})
    expect(out.total).toBe(0)
    expect(out.lines).toEqual([])
    expect(fmtUsd(out.total)).toBe('$0,00')
  })

  it('prices each counter and sorts the biggest line first', () => {
    const out = spendBreakdown({
      apify_ig_results: 1000,      // $2.30
      gemini_flash_calls: 100,     // $0.175
      apify_story_runs: 1,         // $0.099
    })
    expect(out.total).toBeCloseTo(2.30 + 0.175 + 0.099, 6)
    expect(out.lines.map((l) => l.key)).toEqual([
      'apify_ig_results', 'gemini_flash_calls', 'apify_story_runs',
    ])
  })

  it('ignores a counter it has no price for rather than guessing one', () => {
    // apify_runs is free and detections_written is volume, not money. Inventing
    // a price for either is precisely the bug this table replaced.
    const out = spendBreakdown({ apify_runs: 500, detections_written: 4000 })
    expect(out.total).toBe(0)
    expect(VOLUME_COUNTERS.apify_runs).toBeTruthy()
    expect(COST_PER_UNIT.apify_runs).toBeUndefined()
  })

  it('leaves out a priced counter that is simply zero', () => {
    expect(spendBreakdown({ gemini_flash_calls: 0 }).lines).toEqual([])
  })

  it('every priced unit has a label and a note', () => {
    for (const key of Object.keys(COST_PER_UNIT)) {
      expect(UNIT_META[key], `no UNIT_META for ${key}`).toBeTruthy()
      expect(UNIT_META[key].label.length).toBeGreaterThan(0)
      expect(UNIT_META[key].note.length).toBeGreaterThan(0)
    }
  })
})

describe('degradeLevel', () => {
  it('changes rung at 70, 85, 95 and 100 percent', () => {
    expect(degradeLevel(3.49, 5)).toBe('normal')      // 69.8%
    expect(degradeLevel(3.5, 5)).toBe('trim')         // 70%
    expect(degradeLevel(4.25, 5)).toBe('brand_only')  // 85%
    expect(degradeLevel(4.75, 5)).toBe('no_scrape')   // 95%
    expect(degradeLevel(5, 5)).toBe('cache_only')     // 100%
    expect(degradeLevel(50, 5)).toBe('cache_only')
  })

  it('treats a missing or nonsensical budget as no throttling', () => {
    // Mirrors the backend, which fails OPEN: a budget lookup that breaks must
    // not silently halt the pipeline.
    expect(degradeLevel(10, 0)).toBe('normal')
    expect(degradeLevel(10, Number.POSITIVE_INFINITY)).toBe('normal')
    expect(degradeLevel(10, Number.NaN)).toBe('normal')
  })

  it('names every rung', () => {
    for (const k of ['normal', 'trim', 'brand_only', 'no_scrape', 'cache_only'] as const) {
      expect(DEGRADE_LABEL[k]).toBeTruthy()
    }
  })
})

describe('what one action costs', () => {
  it('prices a story sweep as one run fee plus the handles', () => {
    // The whole reason every handle goes into ONE run: 28 separate runs would
    // be 28 x $0.099 before a single username is charged for.
    expect(storySweepCost(28)).toBeCloseTo(0.099 + 28 * 0.003, 6)
    expect(storySweepCost(28)).toBeCloseTo(0.183, 6)
    // Doubling the roster must not double the total — the run fee is fixed.
    expect(storySweepCost(56)).toBeLessThan(storySweepCost(28) * 2)
  })

  it('prices scans per RESULT, which is how Apify bills', () => {
    expect(creatorScanCost(80, 8)).toBeCloseTo(640 * 0.0023, 6)
    expect(hashtagScanCost(500, 50)).toBeCloseTo(25_000 * 0.0023, 6)
  })

  it('shows that one hashtag scan still projects above a $5 day', () => {
    // History: the shipped defaults (500×50) projected ~$57.50 per click —
    // an order of magnitude over the daily budget, and the reason costs went
    // on screen at all. The defaults are now 150×30 (~$10) and the SERVER
    // trims any request to the remaining budget before enqueueing — so the
    // projection here is the opening bid, not what gets spent. It must still
    // read as "more than a day" though: that gap is why the trim exists, and
    // a card claiming a click fits comfortably inside $5 would hide it.
    const scan = hashtagScanCost(DEFAULTS.hashtagPerTag, DEFAULTS.hashtagMaxTags)
    expect(scan).toBeGreaterThan(5)
    expect(scan).toBeLessThan(50) // the order-of-magnitude era must not return
  })

  it('spells out the arithmetic behind every price', () => {
    for (const r of recipes(28)) {
      expect(r.formula, `${r.id} has no formula`).toBeTruthy()
      expect(r.usd).toBeGreaterThan(0)
    }
    expect(recipes(28).find((r) => r.id === 'stories')!.usd).toBeCloseTo(0.183, 6)
  })

  it('falls back to the server cap when the roster size is unknown', () => {
    expect(recipes(0).find((r) => r.id === 'stories')!.usd)
      .toBeCloseTo(storySweepCost(DEFAULTS.storyMaxHandles), 6)
  })
})

describe('projection', () => {
  it('only projects what actually runs on a schedule', () => {
    // scheduled_stories is the sole cron. Projecting a monthly total for the
    // manual buttons would be inventing a usage pattern.
    const p = projection(28, true)
    expect(p.fixedPerMonth).toBeCloseTo(0.183 * 4 * 30, 4)
    // Same bound as the price-card test above: the per-click projection sits
    // above a $5 day (why the server-side trim exists) at the new defaults.
    expect(p.perHashtagScan).toBeGreaterThan(5)
  })

  it('is zero fixed cost when automatic fetching is off', () => {
    const p = projection(28, false)
    expect(p.fixedPerMonth).toBe(0)
    expect(p.fixedNote).toMatch(/uit/)
    // ...but the per-click prices still apply.
    expect(p.perCreatorScan).toBeGreaterThan(0)
  })
})

describe('fmtUsd', () => {
  it('keeps sub-cent prices visible instead of rounding them to nothing', () => {
    // $0.00175 shown as "$0,00" would make every analysis look free.
    expect(fmtUsd(0.00175)).toBe('$0,0018')
    expect(fmtUsd(0)).toBe('$0,00')
    expect(fmtUsd(57.5)).toBe('$57,50')
    expect(fmtUsd(Number.NaN)).toBe('—')
  })
})
