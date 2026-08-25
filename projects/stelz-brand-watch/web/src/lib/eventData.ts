// One data source for an event's campaign, wherever the page runs.
//
// Locally the dev-server fixtures win when they exist — they are the analysis
// workbench, always fresher than any import. Everywhere else (production, and
// a dev machine whose .tmp/ holds no fixtures yet) the rows come from
// Firestore, where 78_upload_event.py put them via api_import_event. Before
// this hook existed the event pages had ONLY the preview path, so in
// production they rendered "Nog geen data" over a fully harvested campaign —
// and a fresh clone dead-ended the same way in dev.
//
// The hook returns the same shapes the preview path produced, so the whole
// downstream pipeline — joinCampaign, matchEvent, evidencedHandlesFor,
// groupHitsByPost — is byte-for-byte the same code on both paths. Attribution
// stays derived, never trusted from a stored label.

import { useEffect, useState } from 'react'
import {
  NO_AUDIENCE, NO_FIXTURE, previewWanted,
  useAudiencePreview, useCampaignDetectionsPreview, useCampaignPreview,
} from './devPreview'
import {
  fbFetchEventAudience, fbFetchEventCampaign, type EventCampaign,
} from './firestore'
import type { Audience } from './audience'
import type { CampaignItem } from './campaign'
import type { DetectionRow } from './types'

/** Is the preview switch on for this tab? Synchronous on purpose: the preview
 *  FETCH is async, and starting a live Firestore read in the gap before the
 *  fixture arrives would flash live rows under a preview banner. Campaign
 *  preview is default-ON in dev (see previewWanted); `?preview=off` remains
 *  the escape hatch. When the fixture then turns out to be MISSING — the
 *  NO_FIXTURE sentinel — the hooks below fall back to the live rows anyway. */
function previewActive(): boolean {
  return import.meta.env.DEV && previewWanted(window.location.search, 'campaign')
}

export function useEventCampaign(eventId: string | null): {
  items: CampaignItem[] | null
  detections: DetectionRow[]
  /** True when the rows on screen come from the LOCAL fixture — the pages say
   *  so on screen. False on the live path, including the fixture-missing
   *  fallback: a banner claiming "your last scrape" over Firestore rows would
   *  be exactly the kind of lie the banner exists to prevent. */
  preview: boolean
  loading: boolean
} {
  const previewItems = useCampaignPreview()
  const previewDets = useCampaignDetectionsPreview()
  // Settled-by-reference: the fixture request finished and there was nothing.
  // Distinct from `null`, which means "still in flight".
  const fixtureMissing = previewItems === NO_FIXTURE
  const [live, setLive] = useState<EventCampaign | null>(null)
  const [liveSettled, setLiveSettled] = useState(false)

  useEffect(() => {
    if (!eventId) return
    if (previewActive() && !fixtureMissing) return
    let cancelled = false
    fbFetchEventCampaign(eventId)
      .then((r) => { if (!cancelled) setLive(r) })
      .catch(() => { if (!cancelled) setLive(null) })
      .finally(() => { if (!cancelled) setLiveSettled(true) })
    return () => { cancelled = true }
  }, [eventId, fixtureMissing])

  if (previewActive() && !fixtureMissing) {
    return {
      items: previewItems && previewItems.length > 0 ? previewItems : null,
      detections: previewDets ?? [],
      preview: true,
      loading: previewItems == null,
    }
  }
  return {
    items: live && live.items.length > 0 ? live.items : null,
    detections: live?.detections ?? [],
    preview: false,
    loading: eventId != null && !liveSettled,
  }
}

export function useEventAudience(eventId: string | null): Audience | null {
  const preview = useAudiencePreview()
  const audienceMissing = preview === NO_AUDIENCE
  const [live, setLive] = useState<Audience | null>(null)
  useEffect(() => {
    if (!eventId) return
    if (previewActive() && !audienceMissing) return
    let cancelled = false
    void fbFetchEventAudience(eventId).then((a) => { if (!cancelled) setLive(a) })
    return () => { cancelled = true }
  }, [eventId, audienceMissing])
  if (previewActive() && !audienceMissing) return preview
  return live
}
