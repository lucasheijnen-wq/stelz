// One data source for an event's campaign: everything we have, wherever it is.
//
// There are two places an event's rows can live, and they hold different
// things:
//
//   LOCAL   .tmp fixtures, served by the dev middleware. Whatever the last
//           scrape round on this machine harvested, analysed at full archive
//           resolution (--max-dim 0). Fresher than any upload, and richer:
//           the deployed detector downsizes to 512px and misses hits this one
//           finds.
//   ONLINE  Firestore. Two overlapping sets — what 78_upload_event.py pushed,
//           and what the scheduled cloud scans wrote on their own clock. See
//           firestore.fbFetchEventCampaign for how both are fetched.
//
// THIS HOOK RETURNS THE UNION. It used to return one OR the other: in dev the
// fixture short-circuited the live fetch entirely, so a machine that had
// scraped once could never see what the nightly scan found, and a machine that
// had not scraped at all saw only production. Both halves were real data about
// the same festival and the page could show exactly one of them at a time.
//
// On a collision the LOCAL row wins. Same post, two judgements: the local one
// was made at archive resolution and the online one at 512px, so preferring
// online would let a hit turn back into a miss on refresh.
//
// The shapes are the ones the preview path always produced, so the whole
// downstream pipeline — joinCampaign, matchEvent, evidencedHandlesFor,
// groupHitsByPost — is byte-for-byte the same code on both paths. Attribution
// stays derived, never trusted from a stored label.

import { useEffect, useMemo, useState } from 'react'
import {
  NO_AUDIENCE, NO_FIXTURE, previewWanted,
  useAudiencePreview, useCampaignDetectionsPreview, useCampaignPreview,
} from './devPreview'
import {
  fbFetchEventAudience, fbFetchEventCampaign, type EventCampaign,
} from './firestore'
import { getEvent } from '../data/events'
import { eventWindow } from './events'
import type { Audience } from './audience'
import type { CampaignItem } from './campaign'
import type { DetectionRow } from './types'

/** Is the local fixture wanted for this tab? Campaign preview is default-ON in
 *  dev (see previewWanted); `?preview=off` is the escape hatch, and now means
 *  "online only" rather than "instead of". */
function localWanted(): boolean {
  return import.meta.env.DEV && previewWanted(window.location.search, 'campaign')
}

/** Where the rows on screen came from. Both counts, because a page mixing two
 *  sources has to be able to say so — a banner that reads "your last scrape"
 *  over half-imported rows is exactly the lie the banner exists to prevent. */
export type RowSources = { local: number; online: number }

const NO_ROWS: DetectionRow[] = []

export function useEventCampaign(eventId: string | null): {
  items: CampaignItem[] | null
  detections: DetectionRow[]
  sources: RowSources
  /** True when ANY row on screen came from the local fixture. */
  preview: boolean
  /** True until BOTH sources have settled. The denominator card is gated on
   *  this: content may render from whichever half arrived first, but "X van Y
   *  stuks content" must not be printed over half an answer and then change. */
  loading: boolean
} {
  const previewItems = useCampaignPreview()
  const previewDets = useCampaignDetectionsPreview()
  // Settled-by-reference: the fixture request finished and there was nothing.
  // Distinct from `null`, which means "still in flight".
  const fixtureMissing = previewItems === NO_FIXTURE
  const localSettled = !localWanted() || previewItems != null
  const localItems = useMemo(
    () => (localWanted() && !fixtureMissing && previewItems ? previewItems : []),
    [previewItems, fixtureMissing])
  const localDets = useMemo(
    () => (localWanted() && previewDets && previewDets !== NO_FIXTURE ? previewDets : []),
    [previewDets])

  // The window is what lets the scheduled scans in — without it the fetcher can
  // only ask for the `eventId` label, which none of them writes. Kept as two
  // plain strings rather than an object so the effect's dependency array
  // compares by value; a fresh {start,end} each render would refetch forever.
  const ev = eventId ? getEvent(eventId) : null
  const win = ev ? eventWindow(ev) : null
  const from = win?.start ?? ''
  const to = win?.end ?? ''
  const liveKey = `${eventId ?? ''}|${from}|${to}`

  // The result carries the key it answers, and "settled" is DERIVED from that
  // rather than held as a second flag. Two things fall out of it: switching
  // events is instantly un-settled with no extra render (a synchronous
  // setLiveSettled(false) in the effect body is the cascading-render pattern
  // react-hooks flags), and a slow response for the PREVIOUS event can never be
  // merged into this one's rows — it arrives under the old key and is ignored.
  const [live, setLive] = useState<{ key: string; data: EventCampaign | null } | null>(null)

  useEffect(() => {
    if (!eventId) return
    let cancelled = false
    const key = `${eventId}|${from}|${to}`
    fbFetchEventCampaign(eventId, from && to ? { start: from, end: to } : null)
      .then((data) => { if (!cancelled) setLive({ key, data }) })
      .catch(() => { if (!cancelled) setLive({ key, data: null }) })
    return () => { cancelled = true }
  }, [eventId, from, to])

  const liveSettled = live != null && live.key === liveKey
  const liveData = liveSettled ? live.data : null

  const merged = useMemo(() => {
    const onlineItems = liveData?.items ?? []
    const onlineDets = liveData?.detections ?? []
    // Local first, then online with `set` — so a key present in both keeps the
    // LOCAL row, and `size` after each pass gives the honest per-source count.
    const items = new Map<string, CampaignItem>()
    for (const it of localItems) items.set(it.itemId, it)
    const localItemCount = items.size
    for (const it of onlineItems) if (!items.has(it.itemId)) items.set(it.itemId, it)

    const dets = new Map<string, DetectionRow>()
    for (const d of localDets) dets.set(String(d.detection_id), d)
    for (const d of onlineDets) {
      const k = String(d.detection_id)
      if (!dets.has(k)) dets.set(k, d)
    }
    return {
      items: [...items.values()],
      detections: [...dets.values()],
      sources: { local: localItemCount, online: items.size - localItemCount },
    }
  }, [localItems, localDets, liveData])

  return {
    items: merged.items.length > 0 ? merged.items : null,
    detections: merged.detections.length > 0 ? merged.detections : NO_ROWS,
    sources: merged.sources,
    preview: merged.sources.local > 0,
    loading: eventId != null && (!liveSettled || !localSettled),
  }
}

export function useEventAudience(eventId: string | null): Audience | null {
  const preview = useAudiencePreview()
  const audienceMissing = preview === NO_AUDIENCE
  const [live, setLive] = useState<Audience | null>(null)
  useEffect(() => {
    if (!eventId) return
    let cancelled = false
    void fbFetchEventAudience(eventId).then((a) => { if (!cancelled) setLive(a) })
    return () => { cancelled = true }
  }, [eventId])
  // Not a union: an audience is an AGGREGATE (counts over commenters and
  // accounts), and adding two aggregates row-wise would double-count everyone
  // who appears in both. The local one wins when it exists because 76_audience
  // ran over the full archive; otherwise the imported summary stands.
  if (localWanted() && !audienceMissing && preview) return preview
  return live
}
