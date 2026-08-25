/// <reference types="node" />
// The dev server turns a URL a browser sent into a path on disk. This is the
// test for the part that decides whether it may.
//
// The stakes are not abstract. .tmp/ sits three directories above the web root
// and firebase/functions/.env is a sibling of it, holding the Gemini key and
// the Apify token. A middleware that joins user input onto a base directory
// hands that file out, and the failure is silent: it looks like a working
// image server right up until someone types the right URL.
import { describe, expect, it } from 'vitest'
import { parseByteRange, resolvePreviewMedia, ARCHIVE_KINDS } from '../../preview-paths'

const roots = {
  eventsTmp: '/repo/.tmp/events',
  defaultEvent: 'lowlands-2026',
  eventIds: new Set(['lowlands-2026', 'pinkpop-2027']),
}
const at = (url: string) => resolvePreviewMedia(url, roots)

describe('what it serves', () => {
  it('resolves the three-segment form', () => {
    expect(at('/preview-media/lowlands-2026/tiktok/abc.jpg')?.file)
      .toBe('/repo/.tmp/events/lowlands-2026/tiktok/media/abc.jpg')
  })

  it('resolves the bare form to the default event\'s stories', () => {
    // The shape 61_stories_preview_fixture.py used to emit; old fixtures on
    // disk still carry it.
    expect(at('/preview-media/123.jpg')?.file)
      .toBe('/repo/.tmp/events/lowlands-2026/stories/media/123.jpg')
  })

  it('knows every archive kind', () => {
    for (const kind of ARCHIVE_KINDS) {
      expect(at(`/preview-media/lowlands-2026/${kind}/x.jpg`), kind).not.toBeNull()
    }
  })

  it('labels the content type from the extension', () => {
    expect(at('/preview-media/lowlands-2026/tiktok/x.mp4')?.type).toBe('video/mp4')
    expect(at('/preview-media/lowlands-2026/stories/x.png')?.type).toBe('image/png')
  })
})

describe('what it refuses', () => {
  it('refuses to climb out', () => {
    for (const url of [
      '/preview-media/../../../firebase/functions/.env',
      '/preview-media/lowlands-2026/../../../.env',
      '/preview-media/lowlands-2026/tiktok/../../../../.env',
      '/preview-media/..%2f..%2ffirebase%2ffunctions%2f.env',
      '/preview-media/%2e%2e/%2e%2e/.env',
    ]) {
      expect(at(url), url).toBeNull()
    }
  })

  it('refuses a traversal hidden in the middle segment', () => {
    // basename runs on EVERY segment, not just the last. A check that only
    // sanitised the filename would let this through.
    expect(at('/preview-media/lowlands-2026/../tiktok/x.jpg')).toBeNull()
    expect(at('/preview-media/../lowlands-2026/tiktok/x.jpg')).toBeNull()
  })

  it('refuses an event that has no definition', () => {
    expect(at('/preview-media/tomorrowland-2026/tiktok/x.jpg')).toBeNull()
    // Membership, not prefix: a longer id starting with a real one is still
    // not that event.
    expect(at('/preview-media/lowlands-2026-evil/tiktok/x.jpg')).toBeNull()
  })

  it('refuses a kind that is not an archive', () => {
    expect(at('/preview-media/lowlands-2026/raw/x.jpg')).toBeNull()
    expect(at('/preview-media/lowlands-2026/negatives/x.jpg')).toBeNull()
    expect(at('/preview-media/lowlands-2026/../x.jpg')).toBeNull()
  })

  it('never falls back to the default event when the URL named another', () => {
    // The dangerous convenience: serving SOMETHING for an unrecognised event.
    // Then the allow-list stops being one, because every URL resolves.
    expect(at('/preview-media/onbekend/tiktok/x.jpg')).toBeNull()
  })

  it('refuses shapes that do not exist', () => {
    expect(at('/preview-media/')).toBeNull()
    expect(at('/preview-media/lowlands-2026/tiktok')).toBeNull()          // 2 segments
    expect(at('/preview-media/lowlands-2026/tiktok/media/x.jpg')).toBeNull()  // 4
  })

  it('refuses anything that is not archived media', () => {
    // A media directory holds images and clips. Nothing else may be read out
    // of it by extension, even if it happens to be there.
    for (const name of ['x.json', 'x.env', 'x', 'x.jsx', 'x.ts', '.env']) {
      expect(at(`/preview-media/lowlands-2026/tiktok/${name}`), name).toBeNull()
    }
  })

  it('refuses a URL that is not a preview URL at all', () => {
    expect(at('/assets/index.js')).toBeNull()
    expect(at('/preview-mediaX/lowlands-2026/tiktok/x.jpg')).toBeNull()
  })

  it('refuses a malformed escape instead of passing the raw bytes on', () => {
    expect(at('/preview-media/%zz/tiktok/x.jpg')).toBeNull()
  })
})

describe('parseByteRange', () => {
  it('serves videos in pieces — the browser cannot seek without 206', () => {
    expect(parseByteRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
    expect(parseByteRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 })
    expect(parseByteRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
    // An end past the file clamps instead of erroring — per RFC 9110.
    expect(parseByteRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 })
  })

  it('falls back to the whole file on anything it does not implement', () => {
    expect(parseByteRange(undefined, 1000)).toBeNull()
    expect(parseByteRange('bytes=', 1000)).toBeNull()
    expect(parseByteRange('bytes=abc-def', 1000)).toBeNull()
    expect(parseByteRange('bytes=0-99,200-299', 1000)).toBeNull()  // multi-range
    expect(parseByteRange('bytes=50-10', 1000)).toBeNull()         // inverted
  })

  it('answers 416 for a range that starts past the end', () => {
    expect(parseByteRange('bytes=1000-', 1000)).toBe('unsatisfiable')
    expect(parseByteRange('bytes=-0', 1000)).toBe('unsatisfiable')
  })
})
