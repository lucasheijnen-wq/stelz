import { describe, expect, it } from 'vitest'
import { CHUNK, chunksOf, remainderOf } from './scanChunks'

describe('the chunk size is the timeout arithmetic', () => {
  it('keeps one request to a single Apify batch', () => {
    // scan_creators uses IG_BATCH = 10. A chunk larger than that puts two or
    // more 210-second Apify calls in one 540-second request, which is the
    // killed container this whole change exists to stop.
    expect(CHUNK).toBe(10)
  })

  it('turns the real 28-person roster into three safe requests', () => {
    const roster = Array.from({ length: 28 }, (_, i) => `instagram_a${i}`)
    const pieces = chunksOf(roster)
    expect(pieces.map((p) => p.length)).toEqual([10, 10, 8])
    expect(pieces.every((p) => p.length <= CHUNK)).toBe(true)
  })
})

describe('chunksOf', () => {
  it('covers the roster exactly once, in order', () => {
    const roster = ['a', 'b', 'c', 'd', 'e']
    expect(chunksOf(roster, 2).flat()).toEqual(roster)
  })

  it('has nothing to do for an empty roster', () => {
    expect(chunksOf([], 10)).toEqual([])
  })

  it('refuses a size that would loop forever', () => {
    expect(() => chunksOf(['a'], 0)).toThrow()
  })
})

describe('remainderOf', () => {
  it('is empty when the server got through the chunk', () => {
    expect(remainderOf(['a', 'b', 'c'], 0)).toEqual([])
  })

  it('returns only the tail the server never started', () => {
    // Resending the whole chunk would pay Apify a second time for the handles
    // that already succeeded.
    expect(remainderOf(['a', 'b', 'c', 'd'], 2)).toEqual(['c', 'd'])
  })

  it('treats a missing count as done rather than as everything', () => {
    // An old backend answers without the field. Reading that as "all of it
    // remains" would loop the chunk until the retry cap, at full price each
    // pass.
    expect(remainderOf(['a', 'b'], undefined)).toEqual([])
    expect(remainderOf(['a', 'b'], null)).toEqual([])
    expect(remainderOf(['a', 'b'], 'two')).toEqual([])
  })

  it('clamps a count larger than the chunk instead of slicing negatively', () => {
    expect(remainderOf(['a', 'b'], 99)).toEqual(['a', 'b'])
  })

  it('ignores a negative count', () => {
    expect(remainderOf(['a', 'b'], -3)).toEqual([])
  })

  it('drains: each pass is strictly shorter, so the loop must terminate', () => {
    let chunk = ['a', 'b', 'c', 'd']
    const lengths: number[] = []
    // The server gets one further each time.
    for (const left of [3, 2, 1, 0]) {
      chunk = remainderOf(chunk, left)
      lengths.push(chunk.length)
    }
    expect(lengths).toEqual([3, 2, 1, 0])
  })
})
