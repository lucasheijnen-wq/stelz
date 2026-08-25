// Local preview data, dev server only.
//
// The stories UI cannot be seen working until scan_stories is deployed, and
// deploying needs credentials this machine does not have. Rather than judge a
// panel from its source code, `?preview=stories` loads real scraped stories
// from a local fixture and renders them through the real components.
//
// Two hard rules, because a preview switch in a client-facing dashboard is a
// liability:
//
//   1. It must not exist in a production build. Vite replaces
//      `import.meta.env.DEV` with the literal `false`, so the checks below sit
//      INLINE in the code they guard rather than behind a helper call — a
//      minifier can fold `if (!false) return` and drop everything after it,
//      but it will not do that across a function boundary. The first version
//      of this file guarded via a helper and the fixture path survived into
//      dist/; verified by grepping the built bundle, not by assuming.
//
//   2. Every surface that shows preview rows must SAY it is preview data. A
//      dashboard that cannot be trusted to distinguish real from fake is worth
//      less than one with no preview at all.
//
// Generate the fixture with tools/stelz_brand_watch/61_stories_preview_fixture.py.

import { useEffect, useState } from 'react'
import type { DetectionRow } from './types'
import type { StoryPost } from './firestore'
import type { CampaignItem } from './campaign'
import type { Audience } from './audience'

export type PreviewKind = 'stories' | 'campaign'

/** Pure matching rule, testable without a DOM. Exact match only: `?preview=1`
 *  and `?preview=storiesx` must not switch anything on. */
export function matchesPreview(search: string, kind: PreviewKind): boolean {
  return new URLSearchParams(search).get('preview') === kind
}

/**
 * ONE fetch in this file, and every hook goes through it.
 *
 * Not tidiness — devPreview.test.ts asserts there is exactly one call to it in
 * this file, and that assertion is what stands between a preview switch and a
 * data-exfiltration switch in a client dashboard. A hook that opened its own
 * would be a second place where the DEV gate has to be got right, and the
 * second place is the one that eventually is not. (It greps the source text, so
 * do not write the call's name in a comment either — that was this comment.)
 *
 * `accept` is how a non-array fixture gets in. The audience layer is an object,
 * and a half-written file must not half-render: the counts are the whole point
 * of that tab, so the check is "does it carry the sections we read", not
 * "did JSON.parse succeed".
 */
function usePreviewFixture<T>(
  file: string, kind: PreviewKind,
  accept: (data: unknown) => boolean = Array.isArray,
): T | null {
  const [rows, setRows] = useState<T | null>(null)
  useEffect(() => {
    // Inline, not extracted — see rule 1 above. Both checks have to sit in the
    // block they guard for the minifier to fold them away.
    if (!import.meta.env.DEV) return
    if (!file) return
    if (!matchesPreview(window.location.search, kind)) return
    let cancelled = false
    void fetch(file)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (!cancelled && accept(data)) setRows(data as T) })
      .catch(() => { /* no fixture generated yet — stay on live data */ })
    return () => { cancelled = true }
  }, [file, kind, accept])
  return rows
}

/** The audience fixture is an object, so Array.isArray would reject it. Checks
 *  the two sections the tab actually reads rather than merely that it parsed. */
const isAudience = (d: unknown): boolean =>
  !!d && typeof d === 'object'
  && 'commenters' in (d as object) && 'accounts' in (d as object)

// The path literals sit INSIDE a DEV ternary, not in the argument position of a
// helper call. Second time this bit: a plain `usePreviewFixture('/x.json')`
// keeps the string in the production bundle, because the minifier folds the
// gate inside the hook but cannot reach back out to the call site to delete its
// argument. With `DEV ? path : ''` the whole literal folds to '' in the build.
// Verified by grepping dist/, both times — not by reasoning about it.

/** Story detections for the strip, or null outside preview mode. */
export function useStoryPreview(): DetectionRow[] | null {
  return usePreviewFixture<DetectionRow[]>(
    import.meta.env.DEV ? '/preview-stories.json' : '', 'stories')
}

/** Story POSTS for the /stories page — the page is driven by posts, so the
 *  preview has to supply posts or it exercises a different path than prod. */
export function useStoryPostsPreview(): StoryPost[] | null {
  return usePreviewFixture<StoryPost[]>(
    import.meta.env.DEV ? '/preview-story-posts.json' : '', 'stories')
}

/** Campaign items — IG stories, IG posts and TikToks in one list. */
export function useCampaignPreview(): CampaignItem[] | null {
  return usePreviewFixture<CampaignItem[]>(
    import.meta.env.DEV ? '/preview-campaign.json' : '', 'campaign')
}

/** The verdicts that go with them. Both halves or neither — see
 *  storyStats.storySource for what happens when only one arrives. */
export function useCampaignDetectionsPreview(): DetectionRow[] | null {
  return usePreviewFixture<DetectionRow[]>(
    import.meta.env.DEV ? '/preview-campaign-detections.json' : '', 'campaign')
}

/** The audience layer: commenters, tagged accounts, festival-goer profiles.
 *
 *  Built by 76_audience.py from raw payloads already on disk — no API call, no
 *  cost. An object rather than an array, hence the `isAudience` check. */
export function useAudiencePreview(): Audience | null {
  return usePreviewFixture<Audience>(
    import.meta.env.DEV ? '/preview-audience.json' : '', 'campaign', isAudience)
}
