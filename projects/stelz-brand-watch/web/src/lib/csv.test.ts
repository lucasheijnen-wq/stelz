// CSV export — lib/csv.ts
//
// The interesting test here is the formula-injection one. Captions come from
// the open internet and land in a file a brand manager opens in Excel; a
// caption beginning "=" is a formula there, not text.

import { describe, it, expect } from 'vitest'
import { detectionsCsv, communitiesCsv, campaignCsv, datedFilename } from './csv'
import { joinCampaign } from './campaign'
import { HIT_COLUMNS } from './hits'
import type { DetectionRow } from './types'

function row(p: Partial<DetectionRow>): DetectionRow {
  return {
    detection_id: 'd1', creator_id: null, creator_handle: 'anna',
    creator_category: null, platform: 'instagram', product_line: null,
    confidence: 0.9, size_in_frame: null, is_primary_subject: null,
    image_url: null, stored_path: null, post_url: null, post_caption: null,
    posted_at: null, likes_count: null, comments_count: null, views_count: null,
    follower_count: null, creator_tier: null, verified: null, context: null,
    post_hashtags: null, post_mentions: null, music: null, extras: null,
    surface_type: null, visible_text: null, false_positive_risk: null,
    people_count: null, setting: null, activity: null, gate: null,
    verify_verdict: null, verify_brand: null, verify_reason: null,
    sentiment: null, sentiment_score: null, sentiment_rationale: null,
    brand_id: 'stelz', detected: true, is_false_positive: null, ...p,
  }
}

describe('detectionsCsv', () => {
  it('neutralises captions that Excel would run as a formula', () => {
    const csv = detectionsCsv([row({ post_caption: '=HYPERLINK("http://x","click")' })])
    expect(csv).toContain(`"'=HYPERLINK`)
  })

  it('neutralises the other formula lead-ins too', () => {
    for (const lead of ['+1', '-1+1', '@SUM(A1)']) {
      const csv = detectionsCsv([row({ post_caption: lead })])
      expect(csv, lead).toContain(`"'${lead.replace(/"/g, '""')}"`)
    }
  })

  it('survives captions containing quotes, commas and newlines', () => {
    const csv = detectionsCsv([row({ post_caption: 'hij zei "top", en\nging weg' })])
    expect(csv).toContain('"hij zei ""top"", en\nging weg"')
    // The header row plus one record; the embedded newline must not split it.
    expect(csv.split('\r\n')[0]).toContain('posted_at')
  })

  it('writes empty strings, never "null" or "0", for missing values', () => {
    const csv = detectionsCsv([row({})])
    expect(csv).not.toContain('null')
    expect(csv).not.toContain('undefined')
  })

  it('starts with a BOM so Excel reads the accents in Stëlz', () => {
    expect(detectionsCsv([row({})]).charCodeAt(0)).toBe(0xfeff)
  })

  it('includes the discovery class, which is the whole point of the tool', () => {
    const csv = detectionsCsv([row({ post_hashtags: ['zomer'] })])
    expect(csv).toContain('visual_only')
  })
})

describe('communitiesCsv', () => {
  it('renders an empty profile list as a header alone', () => {
    const csv = communitiesCsv([])
    expect(csv.split('\r\n')).toHaveLength(1)
    expect(csv).toContain('scene')
  })
})

describe('campaignCsv', () => {
  const hits = () => joinCampaign([
    {
      itemId: 'tt', platform: 'tiktok', surface: 'tiktok', creatorHandle: 'anna',
      url: 'https://tiktok.com/@anna/video/1', coverUrl: null, videoUrl: null,
      mediaType: 'video', postedAt: '2026-08-22T12:00:00Z', caption: null,
      hashtags: [], mentions: [], videoDuration: null,
      views: 194_300, likes: 7_674, comments: 31, shares: 0, saves: 42, pollVotes: null,
      isPaidPartnership: false,
    },
    {
      itemId: 'st', platform: 'instagram', surface: 'story', creatorHandle: 'cato',
      url: null, coverUrl: null, videoUrl: null,
      mediaType: 'image', postedAt: '2026-08-20T12:00:00Z', caption: null,
      hashtags: [], mentions: [], videoDuration: null,
      views: null, likes: null, comments: null, shares: null, saves: null, pollVotes: null,
      isPaidPartnership: false,
    },
  ], [row({ post_id: 'tt' }), row({ post_id: 'st', detection_id: 'd2' })])

  it('leaves an unpublished figure empty rather than writing a zero', () => {
    // The load-bearing one. A story has no view count; a 0 there becomes
    // "nobody watched" the moment somebody sums the column in a sheet.
    const [header, ttRow, stRow] = campaignCsv(hits()).split('\r\n')
    const col = header.split(',').findIndex((h) => h === '"Weergaven"')
    expect(col).toBeGreaterThan(-1)
    expect(ttRow.split(',')[col]).toBe('"194300"')
    expect(stRow.split(',')[col]).toBe('""')
  })

  it('keeps a measured zero, because that one IS a measurement', () => {
    const header = campaignCsv(hits()).split('\r\n')[0].split(',')
    const col = header.findIndex((h) => h === '"Delen"')
    expect(campaignCsv(hits()).split('\r\n')[1].split(',')[col]).toBe('"0"')
  })

  it('exports exactly the columns the table shows, plus the link', () => {
    const header = campaignCsv([]).split('\r\n')[0]
    for (const c of HIT_COLUMNS) expect(header).toContain(`"${c.label}"`)
    expect(header).toContain('"Link"')
  })

  it('neutralises a caption that Excel would run as a formula', () => {
    const rows = joinCampaign([{
      itemId: 'x', platform: 'instagram', surface: 'post', creatorHandle: 'anna',
      url: null, coverUrl: null, videoUrl: null, mediaType: 'image',
      postedAt: '2026-08-20T12:00:00Z', caption: null, hashtags: [], mentions: [],
      videoDuration: null, views: null, likes: 1, comments: null, shares: null,
      saves: null, pollVotes: null, isPaidPartnership: false,
    }], [row({ post_id: 'x', context: '=HYPERLINK("http://x","klik")' })])
    expect(campaignCsv(rows)).toContain(`"'=HYPERLINK`)
  })

  it('renders an empty selection as a header alone', () => {
    expect(campaignCsv([]).split('\r\n')).toHaveLength(1)
  })
})

describe('datedFilename', () => {
  it('dates the file so two exports do not overwrite each other', () => {
    expect(datedFilename('stelz-hits', '2026-08-18T09:00:00Z')).toBe('stelz-hits-2026-08-18.csv')
  })
})
