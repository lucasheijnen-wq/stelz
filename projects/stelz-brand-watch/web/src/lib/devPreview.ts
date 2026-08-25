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

/** Should this preview kind be live for this URL?
 *
 *  The two kinds default differently, on purpose. The campaign fixtures are the
 *  ONLY local source for the event pages — without them the pages show an empty
 *  production database, which read as "my scraped data is gone" every time
 *  someone opened the page without the magic parameter. So campaign is ON by
 *  default in dev, with `?preview=off` as the escape hatch. Stories fixtures
 *  would instead MASK live Firestore data on the stories surfaces, so they stay
 *  strictly opt-in via the exact-match rule above. */
export function previewWanted(search: string, kind: PreviewKind): boolean {
  if (kind === 'campaign') {
    return new URLSearchParams(search).get('preview') !== 'off'
  }
  return matchesPreview(search, kind)
}

/** One settled promise per fixture path, for the whole page session. The two
 *  campaign files are 12,6 MB together and every hook instance used to pull
 *  its own copy — the events LIST page alone paid that bill twice per row,
 *  doubled again by StrictMode. The production path caches for exactly this
 *  reason (see firestore.ts, fbFetchEventCampaign); since the fixture path
 *  became the dev default it deserves the same. A scrape round ends in a full
 *  page reload, which resets this cache along with the module. */
const FIXTURE_CACHE = new Map<string, Promise<unknown>>()

function loadFixture(file: string): Promise<unknown> {
  // Inline, not extracted — see rule 1 above; the gate must sit directly ahead
  // of the request it guards for the minifier to fold the block away.
  if (!import.meta.env.DEV) return Promise.resolve(null)
  let p = FIXTURE_CACHE.get(file)
  if (!p) {
    p = fetch(file)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
    FIXTURE_CACHE.set(file, p)
  }
  return p
}

/**
 * ONE network request in this file, and every hook goes through it.
 *
 * Not tidiness — devPreview.test.ts asserts there is exactly one call site in
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
  empty?: T,
): T | null {
  // `empty` is what a MISSING fixture resolves to. Undefined (the default)
  // keeps the old behaviour: stay null, let the caller fall back to live data.
  // The campaign hooks pass a settled empty value instead, because since
  // campaign preview became default-on a null that never resolves would leave
  // the event pages loading forever on a machine without fixtures.
  const [rows, setRows] = useState<T | null>(null)
  useEffect(() => {
    if (!import.meta.env.DEV) return
    if (!file) return
    if (!previewWanted(window.location.search, kind)) return
    let cancelled = false
    void loadFixture(file).then((data) => {
      if (cancelled) return
      if (accept(data)) setRows(data as T)
      else if (empty !== undefined) setRows(empty)
    })
    return () => { cancelled = true }
  }, [file, kind, accept, empty])
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

/** Stable settled-empty values. A fresh `[]`/`{}` at the call site would be a
 *  new reference every render and re-run the effect forever through the
 *  dependency array. Exported so eventData can RECOGNISE "the fixture is
 *  missing on this machine" by reference and fall back to the live Firestore
 *  rows — the fresh-clone experience used to dead-end on an empty state. */
export const NO_FIXTURE: never[] = []
export const NO_AUDIENCE = Object.freeze({}) as unknown as Audience

/** Campaign items — IG stories, IG posts and TikToks in one list. */
export function useCampaignPreview(): CampaignItem[] | null {
  return usePreviewFixture<CampaignItem[]>(
    import.meta.env.DEV ? '/preview-campaign.json' : '', 'campaign',
    Array.isArray, NO_FIXTURE)
}

/** The verdicts that go with them. Both halves or neither — see
 *  storyStats.storySource for what happens when only one arrives. */
export function useCampaignDetectionsPreview(): DetectionRow[] | null {
  return usePreviewFixture<DetectionRow[]>(
    import.meta.env.DEV ? '/preview-campaign-detections.json' : '', 'campaign',
    Array.isArray, NO_FIXTURE)
}

/** The audience layer: commenters, tagged accounts, festival-goer profiles.
 *
 *  Built by 76_audience.py from raw payloads already on disk — no API call, no
 *  cost. An object rather than an array, hence the `isAudience` check. */
export function useAudiencePreview(): Audience | null {
  return usePreviewFixture<Audience>(
    import.meta.env.DEV ? '/preview-audience.json' : '', 'campaign', isAudience,
    NO_AUDIENCE)
}
