// Data layer — Firestore only. All UI reads go through this module.
//
// (Supabase fully removed 2026-06; if you need the legacy SQL prod data
// for one-off analytics, query the SQL DB directly server-side.)

import {
  fbFetchDetections,
  fbFetchResonanceForCreator,
  fbFetchTopResonance,
  fbFetchCreatorSubcultures,
  fbFetchCreatorProfiles,
  fbFetchCreatorProfile,
  fbListSubcultures,
  fbRateDetection,
} from './firestore'
import { imageUrlFor as _imageUrlFor, type DetectionRow, type ResonanceRow } from './types'

export type { DetectionRow, ResonanceRow }
export const imageUrlFor = _imageUrlFor

// ────────────── Resonance ──────────────

export function fetchResonanceForCreator(handle: string): Promise<ResonanceRow | null> {
  return fbFetchResonanceForCreator(handle)
}

export function fetchTopResonance(limit = 50): Promise<ResonanceRow[]> {
  return fbFetchTopResonance(limit)
}

// ────────────── Subcultures ──────────────

export function fetchCreatorSubcultures() {
  return fbFetchCreatorSubcultures()
}

export function fetchSubcultures() {
  return fbListSubcultures()
}

export function fetchCreatorProfiles() {
  return fbFetchCreatorProfiles()
}

export function fetchCreatorProfile(handle: string) {
  return fbFetchCreatorProfile(handle)
}

export function tierLabel(tier: string | null | number | null): 'T1' | 'T2' | 'T3' | null {
  if (tier === 'tier_1' || tier === 1) return 'T1'
  if (tier === 'tier_2' || tier === 2) return 'T2'
  if (tier === 'tier_3' || tier === 3) return 'T3'
  return null
}

// ────────────── Detections ──────────────

export function fetchDetections(opts: {
  limit?: number
  detectedOnly?: boolean
  creatorHandle?: string
  sinceIso?: string
  minConfidence?: number
  maxConfidence?: number
  sizes?: string[]
  unreviewedOnly?: boolean
} = {}): Promise<DetectionRow[]> {
  return fbFetchDetections(opts)
}

export function rateDetection(detectionId: string, verdict: 'confirmed' | 'plausible' | 'rejected'): Promise<void> {
  return fbRateDetection(detectionId, verdict)
}

// ────────────── User-local state (shortlist, last-seen) ──────────────
// Lives in localStorage today; will move to /users/{uid} doc in Firestore
// once auth-bound writes are wired.

const LS_KEY = 'spotthebrand:state:v1'
type UserState = {
  shortlist: string[]
  hidden: string[]
  lastSeenAt: string | null
  savedViews: { id: string; name: string; filters: Record<string, unknown> }[]
}
const empty: UserState = { shortlist: [], hidden: [], lastSeenAt: null, savedViews: [] }

export function loadState(): UserState {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return empty
    return { ...empty, ...JSON.parse(raw) }
  } catch {
    return empty
  }
}

export function saveState(s: UserState) {
  localStorage.setItem(LS_KEY, JSON.stringify(s))
}

export function markSeen() {
  const s = loadState()
  saveState({ ...s, lastSeenAt: new Date().toISOString() })
}

export function toggleShortlist(detection_id: string) {
  const s = loadState()
  const next = s.shortlist.includes(detection_id)
    ? s.shortlist.filter((x) => x !== detection_id)
    : [...s.shortlist, detection_id]
  saveState({ ...s, shortlist: next })
  return next
}

export function toggleHidden(handle: string) {
  const s = loadState()
  const next = s.hidden.includes(handle) ? s.hidden.filter((x) => x !== handle) : [...s.hidden, handle]
  saveState({ ...s, hidden: next })
  return next
}

// ────────────── Creator projects ──────────────
// Reads are plain Firestore (any signed-in user); writes go through
// api_projects server-side because project membership changes scan cadence.
export {
  fbListProjects as fetchProjects,
  fbProjectsAction as projectsAction,
} from './firestore'
export type { Project } from './firestore'
