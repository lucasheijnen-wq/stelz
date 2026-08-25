// Regressions for four things that made the dashboard look broken in a demo.
//
// None of them was a crash; all four were the same mistake in different places
// — rendering ABSENT data as though it were MEASURED data. "0 followers" for a
// creator whose follower count was never scraped, "-100%" for a creator whose
// only crime is that we haven't scanned recently, "NO IMAGE" where there was
// never an image to load, and one "(untitled)" row that was really every
// unidentifiable track added together.
//
// The logic lives inline in pages/Home.tsx; these tests cover the exact
// expressions, so they pin the behaviour rather than the rendering.

import { describe, it, expect } from 'vitest'
import { formatFollowers } from './format'
// ── Growth, as computed for the leaderboard ──────────────────────────
type Growth = number | 'new' | null
function growthFor(recent: number, prior: number): Growth {
  return recent === 0 ? null : prior === 0 ? 'new' : ((recent - prior) / prior) * 100
}

describe('leaderboard growth', () => {
  it('says nothing when the creator was quiet in the recent half', () => {
    // THE demo bug. Scans run on demand, so on any day without a fresh scan
    // every creator has recent=0 and the old formula printed a red -100% on
    // every row — a statement about our scan schedule dressed up as a
    // statement about the brand collapsing.
    expect(growthFor(0, 12)).toBeNull()
    expect(growthFor(0, 1)).toBeNull()
  })

  it('never returns -100', () => {
    for (let prior = 1; prior <= 50; prior++) {
      expect(growthFor(0, prior)).not.toBe(-100)
    }
  })

  it('marks a creator with no prior activity as new, not +100%', () => {
    // +100% invites the reader to compare it with a real percentage elsewhere
    // in the same column. "new" is the thing that actually happened.
    expect(growthFor(3, 0)).toBe('new')
  })

  it('computes a real percentage when both halves have data', () => {
    expect(growthFor(6, 3)).toBe(100)
    expect(growthFor(3, 6)).toBe(-50)
    expect(growthFor(4, 4)).toBe(0)
  })

  it('says nothing for a creator with no activity at all', () => {
    expect(growthFor(0, 0)).toBeNull()
  })
})

// ── Follower counts ──────────────────────────────────────────────────

describe('formatFollowers', () => {
  it('returns null for the values that mean "not scraped"', () => {
    // Instagram's hashtag endpoint returns no follower count, so most
    // detections carry null. Printing "0 followers" asserts something false.
    expect(formatFollowers(null)).toBeNull()
    expect(formatFollowers(undefined)).toBeNull()
    expect(formatFollowers(0)).toBeNull()
  })

  it('formats a real count', () => {
    expect(formatFollowers(1234)).toBe('1,234')
  })
})

// ── Top sounds ───────────────────────────────────────────────────────
// The sound tally used to live inline in DashboardSection and was mirrored
// here for testability. It moved to lib/sounds.ts (one shared key for the
// card, the community profiles and the /sounds pages) and is tested directly
// in sounds.test.ts — including the "(untitled)" pooling guard and the
// id-without-title distinctness cases that used to live in this file.
