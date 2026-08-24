// CSV export — the old (Supabase) dashboard had this on both the detections and
// the creators view, and it disappeared in the rebuild. It is the difference
// between a tool someone looks at and a tool someone can work from: the first
// thing a brand manager does with a list of 300 hits is put it in a sheet.

import type { DetectionRow } from './types'
import { classifySignal } from './signal'
import type { CommunityProfile } from './communities'
import type { CampaignRow } from './campaign'
import { HIT_COLUMNS, hitText, hitValue } from './hits'

/**
 * Quote a CSV field.
 *
 * Two things matter beyond the obvious quoting. Captions contain newlines and
 * commas as a matter of course, so everything is quoted unconditionally rather
 * than conditionally — cheaper to reason about than a rule with exceptions.
 *
 * And a field starting with = + - @ is executed as a formula when the file is
 * opened in Excel or Sheets. Captions and handles are attacker-controlled text
 * from the open internet, so they are prefixed with an apostrophe. This is not
 * hypothetical: "=1+1" in a caption is enough to demonstrate it, and worse is
 * possible with the right function.
 */
function field(v: unknown): string {
  if (v === null || v === undefined) return '""'
  let s = String(v)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return `"${s.replace(/"/g, '""')}"`
}

// U+FEFF, as an escape rather than the character itself. Written literally
// this line read `return '' + lines.join(...)` — a concatenation with what
// looks like an empty string, which is an invitation to delete it and
// silently break every export the moment someone tidies up. See
// sourceHygiene.test.ts, which now refuses invisible characters outright.
const BOM = '\uFEFF'

function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers.map(field).join(','), ...rows.map((r) => r.map(field).join(','))]
  // BOM so Excel opens UTF-8 correctly — without it "Stëlz" arrives mangled,
  // which is a poor look on an export of a brand's own name.
  return BOM + lines.join('\r\n')
}

export function detectionsCsv(rows: DetectionRow[]): string {
  return toCsv(
    [
      'posted_at', 'platform', 'creator_handle', 'followers', 'post_url',
      'product_line', 'confidence', 'size_in_frame', 'discovery', 'sentiment',
      'sentiment_rationale', 'activity', 'setting', 'surface', 'people',
      'likes', 'comments', 'views', 'hashtags', 'mentions', 'music',
      'caption', 'ai_notes', 'verified', 'rejected', 'detection_id',
    ],
    rows.map((d) => [
      d.posted_at ?? '',
      d.platform,
      d.creator_handle,
      d.follower_count ?? '',
      d.post_url ?? '',
      d.product_line ?? '',
      d.confidence ?? '',
      d.size_in_frame ?? '',
      d.signal?.signal ?? classifySignal(d).signal,
      d.sentiment ?? '',
      d.sentiment_rationale ?? '',
      d.activity ?? '',
      d.setting ?? '',
      d.surface_type ?? '',
      d.people_count ?? '',
      d.likes_count ?? '',
      d.comments_count ?? '',
      d.views_count ?? '',
      (d.post_hashtags ?? []).join(' '),
      (d.post_mentions ?? []).join(' '),
      d.music?.title ?? '',
      d.post_caption ?? '',
      d.context ?? '',
      d.verified === true ? 'yes' : '',
      d.is_false_positive === true ? 'yes' : '',
      d.detection_id,
    ]),
  )
}

/**
 * Every Stëlz sighting, one row each — the table on screen, as a file.
 *
 * Columns come from HIT_COLUMNS rather than being listed again here, so the
 * export and the screen cannot drift apart. That drift is the normal failure:
 * someone adds a column to the table, nobody adds it to the export, and the
 * spreadsheet a client works from quietly describes an older campaign.
 *
 * BLANKS STAY BLANK. A story has no view count, and writing 0 into that cell
 * turns "Instagram does not tell us" into "nobody watched" the moment somebody
 * sums the column. Numeric columns therefore carry raw numbers or nothing at
 * all — never the "—" the screen shows, which would also make the column
 * unsummable in Excel.
 */
export function campaignCsv(rows: CampaignRow[]): string {
  const headers = [...HIT_COLUMNS.map((c) => c.label), 'Zekerheid', 'Beschrijving', 'Link']
  return toCsv(
    headers,
    rows.map((r) => [
      ...HIT_COLUMNS.map((c) => {
        const v = hitValue(r, c.key)
        if (v == null) return ''
        return c.numeric ? v : hitText(r, c.key)
      }),
      r.confidence != null ? Math.round(r.confidence * 100) : '',
      r.detection?.context ?? '',
      r.url ?? '',
    ]),
  )
}

export function communitiesCsv(profiles: CommunityProfile[]): string {
  return toCsv(
    [
      'scene', 'posts', 'untagged', 'untagged_pct', 'creators',
      'median_followers', 'followers_known_for', 'median_likes',
      'top_hashtags', 'top_sounds', 'activities', 'settings', 'cities',
      'peak_day_pct', 'positive', 'neutral', 'promotional', 'negative', 'scored',
    ],
    profiles.map((p) => [
      p.label,
      p.hits,
      p.untagged,
      p.untaggedPct,
      p.creators,
      p.medianFollowers ?? '',
      p.followersKnownFor,
      p.medianLikes ?? '',
      p.topHashtags.map((h) => `#${h.label}`).join(' '),
      p.topSounds.map((x) => x.label).join(' | '),
      p.topActivities.map((x) => x.label).join(' | '),
      p.topSettings.map((x) => x.label).join(' | '),
      p.topCities.map((x) => x.label).join(' | '),
      p.peakDay ? p.peakDay.pct : '',
      p.sentiment.positive,
      p.sentiment.neutral,
      p.sentiment.promotional,
      p.sentiment.negative,
      p.sentiment.scored,
    ]),
  )
}

/** Trigger a download in the browser. */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Revoke on the next tick — revoking synchronously races the download in
  // Safari and produces an empty file.
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

export function datedFilename(prefix: string, iso = new Date().toISOString()): string {
  return `${prefix}-${iso.slice(0, 10)}.csv`
}
