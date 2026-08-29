import { describe, expect, it } from 'vitest'
import { dedupeKeyOf, postKeyOf, slotOf } from './postIdentity'

// The doubling this prevents, with the real ids from the archive:
// 78_upload_event wrote instagram_Da-82n0IfMN for the post whose Apify payload
// (.tmp/events/lowlands-2026/ig-posts/raw/Da-82n0IfMN.json) has
// id="3944857960016114445". scan_creators writes instagram_3944857960016114445
// for the same post. Both fall inside the event window, so both queries return
// both, and the page counted the post twice.

describe('postKeyOf', () => {
  it('lowercases, because only one of the two writers already does', () => {
    expect(postKeyOf({ postKey: 'Da-82n0IfMN' })).toBe('da-82n0ifmn')
  })

  it('treats an imported row and a scanned row as the same post', () => {
    const imported = { postKey: 'Da-82n0IfMN' }
    const scanned = { postKey: 'da-82n0ifmn' }
    expect(postKeyOf(imported)).toBe(postKeyOf(scanned))
  })

  it('falls back to the parent id for slides written before postKey existed', () => {
    expect(postKeyOf({ parentPostId: 'P123' })).toBe('p123')
  })

  it('prefers postKey over the parent fallback', () => {
    expect(postKeyOf({ postKey: 'AAA', parentPostId: 'P123' })).toBe('aaa')
  })

  it('is null when the row carries neither, so the caller keeps the doc id', () => {
    expect(postKeyOf({})).toBeNull()
    expect(postKeyOf({ postKey: '   ' })).toBeNull()
    expect(postKeyOf({ postKey: 42 })).toBeNull()
  })
})

describe('slotOf', () => {
  it('reads both names, because the two writers disagree on it too', () => {
    expect(slotOf({ slot: 3 })).toBe(3)
    expect(slotOf({ carouselSlot: 3 })).toBe(3)
  })

  it('keeps slot zero', () => {
    // The first slide of every carousel, and the one the cover comes from. A
    // falsy-check here turned it into "no slot", which does not match the
    // imported row's explicit 0 — so slide one deduped against nothing.
    expect(slotOf({ slot: 0 })).toBe(0)
    expect(slotOf({ carouselSlot: 0 })).toBe(0)
  })

  it('is null for a post that is not part of a carousel', () => {
    expect(slotOf({})).toBeNull()
  })

  it('ignores the slot of a single-slide post', () => {
    // MEASURED against the real fixture: all 2.496 imported IG posts carry
    // slot 0, and 78_upload_event stamps slots 1 on the single-image ones.
    // The scanner writes no slot at all for the same post. Honouring that 0
    // would give the pair different dedupe keys and double every ordinary
    // post in the archive — the majority of it.
    expect(slotOf({ slot: 0, slots: 1 })).toBeNull()
    expect(slotOf({ carouselSlot: 0, slots: 1 })).toBeNull()
  })

  it('keeps the slot of a real carousel', () => {
    expect(slotOf({ slot: 0, slots: 10 })).toBe(0)
    expect(slotOf({ slot: 4, slots: 10 })).toBe(4)
  })

  it('keeps the slot when the row does not say how many slides there are', () => {
    // The sidecar writer knows the slide's position but not the total, so an
    // absent `slots` must not be read as "single".
    expect(slotOf({ carouselSlot: 2 })).toBe(2)
  })
})

describe('dedupeKeyOf', () => {
  it('collapses the import row and the scanner row for one post', () => {
    const a = dedupeKeyOf('instagram_Da-82n0IfMN', { postKey: 'Da-82n0IfMN' })
    const b = dedupeKeyOf('instagram_3944857960016114445', { postKey: 'da-82n0ifmn' })
    expect(a).toBe(b)
  })

  it('keeps the slides of a carousel apart', () => {
    // They share a postKey on purpose — that is what makes the rollups count
    // them as one post — but each slide has its own image to show, so they
    // must stay separate ROWS.
    const keys = [0, 1, 2].map((slot) =>
      dedupeKeyOf(`instagram_P123_C${slot}`, { postKey: 'aaa', slot }))
    expect(new Set(keys).size).toBe(3)
  })

  it('matches an imported slide with its scanned twin', () => {
    const imported = dedupeKeyOf('instagram_AAA_s0', { postKey: 'AAA', slot: 0 })
    const scanned = dedupeKeyOf('instagram_P123_C0', { postKey: 'aaa', carouselSlot: 0 })
    expect(imported).toBe(scanned)
  })

  it('collapses an imported single post with its scanned twin', () => {
    // The regression this rule prevents. Import: slot 0, slots 1, mixed-case
    // shortcode. Scanner: no slot, lowercased shortcode. Same post.
    const imported = dedupeKeyOf('instagram_DbYFvHgBgUt',
      { postKey: 'DbYFvHgBgUt', slot: 0, slots: 1 })
    const scanned = dedupeKeyOf('instagram_3944857960016114445',
      { postKey: 'dbyfvhgbgut' })
    expect(imported).toBe(scanned)
  })

  it('collapses an imported story with its scanned twin', () => {
    // Stories were the one surface where both writers already agreed on the
    // doc id, so they deduped for free. Keying on postKey would have BROKEN
    // that unless the scanner wrote one too — the imported row has a postKey
    // and the scanner row would have fallen back to its id.
    const imported = dedupeKeyOf('instagram_story3967203771136678414',
      { postKey: '3967203771136678414' })
    const scanned = dedupeKeyOf('instagram_story3967203771136678414',
      { postKey: '3967203771136678414' })
    expect(imported).toBe(scanned)
  })

  it('collapses an imported tiktok with its scanned twin', () => {
    const imported = dedupeKeyOf('tiktok_7266148366302711073',
      { postKey: '7266148366302711073' })
    const scanned = dedupeKeyOf('tiktok_7266148366302711073',
      { postKey: '7266148366302711073' })
    expect(imported).toBe(scanned)
  })

  it('falls back to the doc id when there is no key, exactly as before', () => {
    expect(dedupeKeyOf('detection_1', {})).toBe('detection_1')
  })

  it('never merges two different posts', () => {
    expect(dedupeKeyOf('a', { postKey: 'aaa' }))
      .not.toBe(dedupeKeyOf('b', { postKey: 'bbb' }))
  })
})
