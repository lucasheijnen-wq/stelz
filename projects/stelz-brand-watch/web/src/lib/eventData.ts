// One data source for an event's campaign, wherever the page runs.
//
// Locally with `?preview=campaign` the dev-server fixtures win — they are the
// analysis workbench, always fresher than any import. Everywhere else the rows
// come from Firestore, where 78_upload_event.py put them via api_import_event.
// Before this hook existed the event pages had ONLY the preview path, so in
// production they rendered "Nog geen data" over a fully harvested campaign.
//
// The hook returns the same shapes the preview path produced, so the whole
// downstream pipeline — joinCampaign, matchEvent, evidencedHandlesFor,
// groupHitsByPost — is byte-for-byte the same code on both paths. Attribution
// stays derived in the client, never trusted from a stored label.

import { useEffect, useState } from 'react'
import {
  useAudiencePreview, useCampaignDetectionsPreview, useCampaignPreview, previewWanted,
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
 *  preview is default-ON in dev (see previewWanted) — the local fixtures are
 *  the only data source for these pages until the one-time production import
 *  runs, and `?preview=off` remains the escape hatch to see the live rows. */
function previewActive(): boolean {
  return import.meta.env.DEV && previewWanted(window.location.search, 'campaign')
}

export function useEventCampaign(eventId: string | null): {
  items: CampaignItem[] | null
  detections: DetectionRow[]
  /** True when the rows come from local fixtures — the pages say so on screen. */
  preview: boolean
  loading: boolean
} {
  const previewItems = useCampaignPreview()
  const previewDets = useCampaignDetectionsPreview()
  const [live, setLive] = useState<EventCampaign | null>(null)
  // True exactly when the effect below will start a fetch. Derived at mount
  // rather than set inside the effect — a synchronous setState in an effect
  // body is the cascade the lint rule exists for, and the initializer already
  // knows everything the guard knows.
  const [loading, setLoading] = useState(() => !previewActive() && eventId != null)

  useEffect(() => {
    if (previewActive() || !eventId) return
    let cancelled = false
    fbFetchEventCampaign(eventId)
      .then((r) => { if (!cancelled) setLive(r) })
      .catch(() => { if (!cancelled) setLive(null) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [eventId])

  if (previewActive()) {
    return {
      // A settled-but-empty fixture (no scrape ran on this machine yet) maps to
      // null so the page shows its empty state instead of a zero-item grid.
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
    loading,
  }
}

export function useEventAudience(eventId: string | null): Audience | null {
  const preview = useAudiencePreview()
  const [live, setLive] = useState<Audience | null>(null)
  useEffect(() => {
    if (previewActive() || !eventId) return
    let cancelled = false
    void fbFetchEventAudience(eventId).then((a) => { if (!cancelled) setLive(a) })
    return () => { cancelled = true }
  }, [eventId])
  return previewActive() ? preview : live
}
