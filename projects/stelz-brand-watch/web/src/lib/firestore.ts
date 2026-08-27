// Firestore reads + writes. Mirrors the domain types.

import {
  collection,
  query,
  where,
  orderBy,
  limit as fsLimit,
  getDocs,
  getDoc,
  doc,
  setDoc,
  updateDoc,
  deleteDoc,
  onSnapshot,
  serverTimestamp,
  Timestamp,
  type Unsubscribe,
  type QueryConstraint,
  type QueryDocumentSnapshot,
  type QuerySnapshot,
  type CollectionReference,
  type DocumentData,
} from 'firebase/firestore'
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage'
import { fbDb, fbAuth, fbStorage } from './firebase'
import type { DetectionRow, ResonanceRow } from './types'
import { surfaceOf, type CampaignItem } from './campaign'
import { dayBounds } from './events'
import type { Audience } from './audience'
import { spendBreakdown, type SpendLine } from './costs'

// Default brand. Replace once brand switcher reads from auth context.
export const BRAND_ID = 'stelz'

// Cloud Functions base URL (Firebase Hosting rewrites or direct functions URL).
const FUNCTIONS_BASE =
  import.meta.env.VITE_FUNCTIONS_BASE ||
  'https://europe-west1-brand-audit-4b2cc.cloudfunctions.net'

function tsToIso(t: unknown): string | null {
  if (!t) return null
  if (t instanceof Timestamp) return t.toDate().toISOString()
  if (typeof t === 'string') return t
  if (typeof t === 'object' && t && 'seconds' in t) {
    return new Date((t as { seconds: number }).seconds * 1000).toISOString()
  }
  return null
}

function mapDetection(d: QueryDocumentSnapshot<DocumentData>, brandId: string): DetectionRow {
  const x = d.data()
  return {
    detection_id: d.id,
    creator_id: typeof x.creatorRef === 'string' ? x.creatorRef : null,
    creator_handle: x.creatorHandle ?? '',
    creator_category: x.creatorCategory ?? null,
    platform: x.platform ?? 'instagram',
    product_line: x.productLine ?? null,
    confidence: x.confidence ?? null,
    size_in_frame: x.sizeInFrame ?? null,
    is_primary_subject: x.isPrimarySubject ?? null,
    image_url: x.imageUrl ?? null,
    stored_path: x.storedPath ?? null,
    post_url: x.postUrl ?? null,
    post_caption: x.postCaption ?? null,
    posted_at: tsToIso(x.postedAt),
    likes_count: x.likesCount ?? null,
    comments_count: x.commentsCount ?? null,
    views_count: x.viewsCount ?? null,
    follower_count: x.followerCount ?? null,
    creator_tier: x.creatorTier ?? null,
    verified: x.verified ?? null,
    context: x.context ?? null,
    post_hashtags: x.postHashtags ?? null,
    post_mentions: x.postMentions ?? null,
    music: (x.music as DetectionRow['music']) ?? null,
    extras: (x.extras as DetectionRow['extras']) ?? null,
    surface_type: (x.surfaceType as string | null) ?? null,
    visible_text: (x.visibleText as string | null) ?? null,
    false_positive_risk: (x.falsePositiveRisk as string | null) ?? null,
    people_count: (x.peopleCount as number | null) ?? null,
    setting: (x.setting as string | null) ?? null,
    activity: (x.activity as string | null) ?? null,
    gate: (x.gate as string | null) ?? null,
    verify_verdict: (x.verifyVerdict as string | null) ?? null,
    verify_brand: (x.verifyBrand as string | null) ?? null,
    verify_reason: (x.verifyReason as string | null) ?? null,
    verify_placement: (x.verifyPlacement as DetectionRow['verify_placement']) ?? null,
    // Absent in production: a deployed detection IS at production
    // resolution, so there is no gap to report. Only the local archive,
    // which can be analysed at a higher one, sets these.
    found_at_prod_res: (x.foundAtProdRes as boolean | null) ?? null,
    max_dim: (x.maxDim as number | null) ?? null,
    sentiment: (x.sentiment as DetectionRow['sentiment']) ?? null,
    sentiment_score: (x.sentimentScore as number | null) ?? null,
    sentiment_rationale: (x.sentimentRationale as string | null) ?? null,
    content_type: (x.contentType as 'image' | 'video' | 'story' | 'unknown' | null) ?? null,
    expires_at: tsToIso(x.expiresAt),
    frame_idx: (x.frameIdx as number | null) ?? null,
    post_id: (x.postId as string | null) ?? null,
    brand_id: brandId,
    detected: x.detected ?? null,
    is_false_positive: x.isFalsePositive ?? null,
    // Optional analysis fields the local pipeline and the event import carry;
    // absent on detections the deployed detector wrote before they existed.
    frames_judged: (x.framesJudged as number | null) ?? null,
    near_miss: (x.nearMiss as boolean | null) ?? null,
    near_miss_reason: (x.nearMissReason as string | null) ?? null,
    cover_only: (x.coverOnly as boolean | null) ?? null,
  }
}

function mapResonance(d: QueryDocumentSnapshot<DocumentData>, brandId: string): ResonanceRow {
  const x = d.data()
  return {
    brand_id: brandId,
    creator_handle: x.handle ?? '',
    platform: x.platform ?? 'instagram',
    srs: x.srs ?? 0,
    graph: x.graph ?? null,
    hashtag: x.hashtag ?? null,
    subculture: x.subculture ?? null,
    comment: x.comment ?? null,
    geo: x.geo ?? null,
    visual: x.visual ?? null,
    bootstrap_mode: x.bootstrapMode ?? null,
    subculture_layer_live: x.subcultureLayerLive as boolean | undefined,
    primary_subculture: (x.primarySubculture as string | null) ?? null,
    computed_at: tsToIso(x.computedAt) ?? new Date().toISOString(),
    creator_id: null,
    full_name: x.fullName ?? null,
    follower_count: x.followerCount ?? null,
    tier: x.tier ?? null,
    status: x.status ?? null,
    category: x.category ?? null,
    relevance_score: x.relevanceScore ?? null,
    clear_visibility_hits: x.clearVisibilityHits ?? null,
    latest_detection_at: tsToIso(x.latestDetectionAt),
    posts_scraped: x.postsScraped ?? null,
  }
}

// ────────────── Reads ──────────────

export async function fbFetchDetections({
  brandId = BRAND_ID,
  limit = 500,
  detectedOnly = true,
  creatorHandle,
  sinceIso,
  minConfidence,
  maxConfidence,
  sizes,
  unreviewedOnly = false,
}: {
  brandId?: string
  limit?: number
  detectedOnly?: boolean
  creatorHandle?: string
  sinceIso?: string
  minConfidence?: number
  maxConfidence?: number
  sizes?: string[]
  unreviewedOnly?: boolean
} = {}): Promise<DetectionRow[]> {
  const col = collection(fbDb, 'brands', brandId, 'detections')
  const clauses: QueryConstraint[] = []
  if (detectedOnly) clauses.push(where('detected', '==', true))
  if (creatorHandle) clauses.push(where('creatorHandle', '==', creatorHandle))
  if (sinceIso) clauses.push(where('postedAt', '>=', Timestamp.fromDate(new Date(sinceIso))))
  if (typeof minConfidence === 'number') clauses.push(where('confidence', '>=', minConfidence))
  if (typeof maxConfidence === 'number') clauses.push(where('confidence', '<', maxConfidence))
  if (sizes?.length) clauses.push(where('sizeInFrame', 'in', sizes))
  if (unreviewedOnly) clauses.push(where('verified', '==', null), where('isFalsePositive', '==', null))
  clauses.push(orderBy('postedAt', 'desc'), fsLimit(limit))
  const snap = await getDocs(query(col, ...clauses))
  return snap.docs.map((d) => mapDetection(d, brandId))
}

/**
 * One captured story, straight from the posts collection.
 *
 * THIS is the authoritative list of "all stories", not the detections below.
 * detect_image writes no detection document when the image fetch fails, and
 * for stories that path is common rather than exceptional — the CDN URLs are
 * short-lived signed links. Building the overview from detections would drop
 * exactly the story we failed to analyse, silently, from a page that promises
 * to show everything.
 */
export type StoryPost = {
  postId: string
  creatorHandle: string
  creatorTier: string | null
  url: string | null
  coverUrl: string | null
  videoUrl: string | null
  mediaType: 'image' | 'video'
  videoDuration: number | null
  postedAt: string | null
  postedAtEstimated: boolean
  expiresAt: string | null
  hashtags: string[]
  mentions: string[]
  /** Public and exact. A vote needs a viewer, so this is a floor on views. */
  pollVotes: number
  pollCount: number
  pollQuestions: string[]
  linkUrls: string[]
  music: { title: string | null; artist: string | null } | null
  isPaidPartnership: boolean
}

function mapStoryPost(d: QueryDocumentSnapshot<DocumentData>): StoryPost {
  const x = d.data()
  const music = x.music as Record<string, unknown> | null | undefined
  return {
    postId: d.id,
    creatorHandle: ((x.creatorHandle as string) ?? '').toLowerCase(),
    creatorTier: (x.creatorTier as string | null) ?? null,
    url: (x.url as string | null) ?? null,
    coverUrl: (x.coverUrl as string | null) ?? null,
    videoUrl: (x.videoUrl as string | null) ?? null,
    mediaType: x.mediaType === 'video' ? 'video' : 'image',
    videoDuration: typeof x.videoDuration === 'number' ? x.videoDuration : null,
    postedAt: tsToIso(x.postedAt),
    postedAtEstimated: x.postedAtEstimated === true,
    expiresAt: tsToIso(x.expiresAt),
    hashtags: (x.hashtags as string[]) ?? [],
    mentions: (x.mentions as string[]) ?? [],
    pollVotes: typeof x.pollVotes === 'number' ? x.pollVotes : 0,
    pollCount: typeof x.pollCount === 'number' ? x.pollCount : 0,
    pollQuestions: (x.pollQuestions as string[]) ?? [],
    linkUrls: (x.linkUrls as string[]) ?? [],
    music: music
      ? { title: (music.title as string) ?? null, artist: (music.artist as string) ?? null }
      : null,
    isPaidPartnership: x.isPaidPartnership === true,
  }
}

/** Needs the posts contentType+postedAt index. Throws until it is live; the
 *  page catches and says so rather than rendering an empty overview. */
export async function fbFetchStoryPosts(limit = 2000, brandId = BRAND_ID): Promise<StoryPost[]> {
  const col = collection(fbDb, 'brands', brandId, 'posts')
  const snap = await getDocs(query(
    col,
    where('contentType', '==', 'story'),
    orderBy('postedAt', 'desc'),
    fsLimit(limit),
  ))
  return snap.docs.map(mapStoryPost)
}

/**
 * Story DETECTIONS — the Stëlz verdicts, hits and misses alike.
 *
 * Its own query on purpose. Every other detection fetch defaults to
 * `detected == true`, which is right for the feed and wrong here: a strip that
 * silently drops the stories without a can in them cannot distinguish "we
 * scraped forty and six had Stëlz" from "we scraped six".
 *
 * Needs the detections contentType+postedAt composite index. Until that index
 * is live the query throws; callers fall back to filtering rows they already
 * hold rather than showing an error, so the panel degrades to hits-only
 * instead of blank.
 */
export async function fbFetchStories(limit = 200, brandId = BRAND_ID): Promise<DetectionRow[]> {
  const col = collection(fbDb, 'brands', brandId, 'detections')
  const snap = await getDocs(query(
    col,
    where('contentType', '==', 'story'),
    orderBy('postedAt', 'desc'),
    fsLimit(limit),
  ))
  return snap.docs.map((d) => mapDetection(d, brandId))
}

export async function fbFetchResonanceForCreator(handle: string, brandId = BRAND_ID): Promise<ResonanceRow | null> {
  const col = collection(fbDb, 'brands', brandId, 'resonance')
  const snap = await getDocs(query(col, where('handle', '==', handle), fsLimit(1)))
  if (snap.empty) return null
  return mapResonance(snap.docs[0], brandId)
}

export async function fbFetchTopResonance(limit = 50, brandId = BRAND_ID): Promise<ResonanceRow[]> {
  const col = collection(fbDb, 'brands', brandId, 'resonance')
  const snap = await getDocs(query(col, orderBy('srs', 'desc'), fsLimit(limit)))
  return snap.docs.map((d) => mapResonance(d, brandId))
}

/** Is this uid a member of the brand?
 *
 * Membership is what separates a moderator from a tester: every write path
 * (api_rate_detection, the scan steps, reference-image writes) is gated on it
 * server-side, in main.py._require_brand_member and in firestore.rules. This
 * read exists purely so the UI can say so up front instead of letting someone
 * click a button that will 403. Never treat a `true` here as authorisation —
 * it is a hint for rendering, and the server checks again regardless.
 */
export async function fbIsBrandMember(uid: string, brandId = BRAND_ID): Promise<boolean> {
  try {
    const snap = await getDoc(doc(fbDb, 'brands', brandId, 'members', uid))
    return snap.exists()
  } catch {
    // Rules deny the read, offline, etc. Assume the safer of the two answers:
    // read-only. A member who sees the banner by mistake loses a button; a
    // tester who doesn't see it gets a confusing 403 instead.
    return false
  }
}

// ────────────── Subcultures (audience scenes) ──────────────

export type SubcultureDef = {
  slug: string
  name: string
  description: string | null
  color: string | null
  emoji: string | null
}

/** Which scenes each creator belongs to. Keyed by handle.
 *
 * A creator with an EMPTY array has been classified and matched nothing —
 * distinct from a creator missing from the map entirely, who has never been
 * classified at all. The dashboard reports those two differently, so the
 * distinction has to survive the read.
 */
export type CreatorSubcultures = Record<string, { slug: string; confidence: number }[]>

export async function fbListSubcultures(brandId = BRAND_ID): Promise<SubcultureDef[]> {
  const snap = await getDocs(collection(fbDb, 'brands', brandId, 'subcultures'))
  return snap.docs.map((d) => {
    const x = d.data()
    return {
      slug: x.slug ?? d.id,
      name: x.name ?? d.id,
      description: x.description ?? null,
      color: x.color ?? null,
      emoji: x.emoji ?? null,
    }
  })
}

export async function fbFetchCreatorSubcultures(brandId = BRAND_ID): Promise<CreatorSubcultures> {
  const snap = await getDocs(collection(fbDb, 'brands', brandId, 'creatorSubcultures'))
  const out: CreatorSubcultures = {}
  for (const d of snap.docs) {
    const x = d.data()
    const handle = ((x.handle as string) ?? d.id ?? '').toLowerCase()
    if (!handle) continue
    out[handle] = ((x.links ?? []) as { slug: string; confidence: number }[])
      .map((l) => ({ slug: l.slug, confidence: l.confidence ?? 0 }))
  }
  return out
}

/** Does this brand have any members at all?
 *
 * An unclaimed brand — no members — is the one case where a non-member must
 * still see the write controls: bootstrap grants ownership to the first caller,
 * and the UI calls bootstrap from the Run scan button. Hiding that button from
 * everyone because nobody is a member yet deadlocks a fresh brand permanently,
 * since the only path to membership runs through the button being clickable.
 *
 * Errors resolve to `true` (claimed), the conservative answer: a spurious
 * "unclaimed" would show a paid action to someone who cannot use it.
 */
export async function fbBrandHasMembers(brandId = BRAND_ID): Promise<boolean> {
  try {
    const snap = await getDocs(query(collection(fbDb, 'brands', brandId, 'members'), fsLimit(1)))
    return !snap.empty
  } catch {
    return true
  }
}

export type CreatorProfile = {
  handle: string
  platform: string
  followerCount: number | null
  bio: string | null
  avatarUrl: string | null
  fullName: string | null
  category: string | null
  tier: string | null
}

/** Creator records, keyed by lowercase handle.
 *
 * Detections carry a snapshot of the creator taken when the post was detected,
 * so they never gain a follower count that arrived afterwards. The creator
 * record does. Anywhere the UI wants "who is this person", this is the source
 * that stays current.
 */
export async function fbFetchCreatorProfiles(brandId = BRAND_ID, limit = 1000): Promise<Record<string, CreatorProfile>> {
  const snap = await getDocs(query(collection(fbDb, 'brands', brandId, 'creators'), fsLimit(limit)))
  const out: Record<string, CreatorProfile> = {}
  for (const d of snap.docs) {
    const x = d.data()
    const handle = ((x.handle as string) ?? '').toLowerCase()
    if (!handle) continue
    out[handle] = {
      handle,
      platform: x.platform ?? 'instagram',
      followerCount: (x.followerCount as number | null) ?? null,
      bio: (x.bio as string | null) ?? null,
      avatarUrl: (x.avatarUrl as string | null) ?? null,
      fullName: (x.fullName as string | null) ?? null,
      category: (x.category as string | null) ?? null,
      tier: (x.tier as string | null) ?? null,
    }
  }
  return out
}

/** One creator record by handle. Cheap targeted read for the Creator page —
 *  fetching the whole collection to render one profile would be absurd. */
export async function fbFetchCreatorProfile(handle: string, brandId = BRAND_ID): Promise<CreatorProfile | null> {
  const snap = await getDocs(query(
    collection(fbDb, 'brands', brandId, 'creators'),
    where('handle', '==', handle.toLowerCase()),
    fsLimit(1),
  ))
  if (snap.empty) return null
  const x = snap.docs[0].data()
  return {
    handle: (x.handle as string) ?? handle,
    platform: x.platform ?? 'instagram',
    followerCount: (x.followerCount as number | null) ?? null,
    bio: (x.bio as string | null) ?? null,
    avatarUrl: (x.avatarUrl as string | null) ?? null,
    fullName: (x.fullName as string | null) ?? null,
    category: (x.category as string | null) ?? null,
    tier: (x.tier as string | null) ?? null,
  }
}

export async function fbFetchBrand(brandId = BRAND_ID) {
  const snap = await getDoc(doc(fbDb, 'brands', brandId))
  return snap.exists() ? { id: snap.id, ...snap.data() } : null
}

// Lightweight collection counts (uses Firestore aggregation, cheap)
export async function fbFetchPipelineCounts(brandId = BRAND_ID): Promise<{
  creators: number
  posts: number
  detections: number
  detectionsHit: number
  discoveryQueue: number
}> {
  const counts = await Promise.all([
    getDocs(query(collection(fbDb, 'brands', brandId, 'creators'), fsLimit(1000))).then((s) => s.size),
    getDocs(query(collection(fbDb, 'brands', brandId, 'posts'), fsLimit(1000))).then((s) => s.size),
    getDocs(query(collection(fbDb, 'brands', brandId, 'detections'), fsLimit(1000))).then((s) => s.size),
    getDocs(query(collection(fbDb, 'brands', brandId, 'detections'), where('detected', '==', true), fsLimit(1000))).then((s) => s.size),
    getDocs(query(collection(fbDb, 'brands', brandId, 'discoveryQueue'), fsLimit(1000))).then((s) => s.size),
  ])
  return {
    creators: counts[0],
    posts: counts[1],
    detections: counts[2],
    detectionsHit: counts[3],
    discoveryQueue: counts[4],
  }
}

export async function fbFetchLatestScanRun(brandId = BRAND_ID) {
  const snap = await getDocs(query(
    collection(fbDb, 'brands', brandId, 'scanRuns'),
    orderBy('finishedAt', 'desc'),
    fsLimit(1),
  ))
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() }
}

// ────────────── Writes (via Cloud Functions) ──────────────

/**
 * A Cloud Function that is merged but NOT DEPLOYED looks like a CORS bug.
 *
 * Google's Functions frontend answers a request for a non-existent function
 * with a bare 404 that carries no Access-Control-Allow-Origin header, so the
 * browser refuses to hand the response to JS and reports "blocked by CORS
 * policy" plus a `TypeError: Failed to fetch`. Nothing about that message
 * points at the actual cause, and it has now cost two debugging sessions —
 * once on api_projects, once on api_step_stories.
 *
 * So: catch the network-level failure and say what it almost always means.
 * A genuine outage produces the same signature, which is why the wording
 * names both possibilities rather than asserting one.
 */
async function authedFetch(path: string, body: unknown) {
  const user = fbAuth.currentUser
  if (!user) throw new Error('Not signed in')
  const token = await user.getIdToken()
  let res: Response
  try {
    res = await fetch(`${FUNCTIONS_BASE}/${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    })
  } catch {
    throw new Error(
      `${path} is niet bereikbaar. Meestal betekent dit dat deze functie nog niet ` +
      `is uitgerold naar productie (een 404 van Cloud Functions komt zonder ` +
      `CORS-header binnen en leest in de browser als een CORS-fout). ` +
      `Anders: geen netwerkverbinding.`,
    )
  }
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`${path} failed: ${res.status} ${text}`)
  }
  return res.json()
}

export async function fbRateDetection(detectionId: string, verdict: 'confirmed' | 'plausible' | 'rejected') {
  await authedFetch('api_rate_detection', { brandId: BRAND_ID, detectionId, verdict })
}

// ────────────── Reference images ──────────────

export type ReferenceImage = {
  id: string
  storagePath: string
  url: string
  productLine?: string | null
  uploadedAt: string | null
  size?: number
  width?: number
  height?: number
}

export async function fbListReferenceImages(brandId = BRAND_ID): Promise<ReferenceImage[]> {
  const col = collection(fbDb, 'brands', brandId, 'referenceImages')
  const snap = await getDocs(query(col, orderBy('uploadedAt', 'desc')))
  return snap.docs.map((d) => {
    const x = d.data()
    return {
      id: d.id,
      storagePath: x.storagePath ?? '',
      url: x.url ?? '',
      productLine: x.productLine ?? null,
      uploadedAt: x.uploadedAt instanceof Timestamp ? x.uploadedAt.toDate().toISOString() : null,
      size: x.size,
      width: x.width,
      height: x.height,
    }
  })
}

export async function fbUploadReferenceImage(
  file: File,
  productLine?: string,
  brandId = BRAND_ID,
): Promise<ReferenceImage> {
  if (!fbAuth.currentUser) throw new Error('Not signed in')
  // sanitize filename to a safe doc id + path
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80)
  const docId = `${Date.now()}_${safeName}`
  const path = `references/${brandId}/${docId}`

  const sref = storageRef(fbStorage, path)
  await uploadBytes(sref, file, { contentType: file.type || 'image/jpeg' })
  const url = await getDownloadURL(sref)

  await setDoc(doc(fbDb, 'brands', brandId, 'referenceImages', docId), {
    storagePath: path,
    url,
    productLine: productLine ?? null,
    size: file.size,
    uploadedAt: serverTimestamp(),
    uploadedBy: fbAuth.currentUser.uid,
  })

  return {
    id: docId,
    storagePath: path,
    url,
    productLine: productLine ?? null,
    uploadedAt: new Date().toISOString(),
    size: file.size,
  }
}

export async function fbDeleteReferenceImage(
  id: string,
  storagePath: string,
  brandId = BRAND_ID,
): Promise<void> {
  await deleteDoc(doc(fbDb, 'brands', brandId, 'referenceImages', id))
  try {
    await deleteObject(storageRef(fbStorage, storagePath))
  } catch (e) {
    console.warn('storage delete failed (doc removed)', e)
  }
}

export async function fbBootstrapBrand(brandName = 'Stelz') {
  return authedFetch('api_bootstrap_brand', { brandId: BRAND_ID, brandName })
}

// Per-step scan API. UI calls these sequentially and shows progress between them.
// Defaults live HERE, not at the call sites. 500/50 projected ~$40 of Apify
// against the $5 default daily budget — the whole day spent in one click. The
// server now trims any request to fit the remaining budget (publish_tags),
// but a client that asks for a sane size to begin with leaves the trim as the
// safety net it should be, not the sizing mechanism.
export async function fbStepHashtags(perTag = 150, maxTags = 30) {
  return authedFetch('api_step_hashtags', { brandId: BRAND_ID, perTag, maxTags })
}
// `creatorIds` (platform_handle composites) scans exactly those creators and
// ignores the due queue. OMITTED, not empty, for the brand-wide scan: the
// server reads a missing key as "use the due queue" and an empty list as "the
// caller named a roster and it was empty", which are opposite instructions.
export async function fbStepCreators(maxCreators = 80, postsPer = 8, creatorIds?: string[]) {
  return authedFetch('api_step_creators', {
    brandId: BRAND_ID, maxCreators, postsPer,
    ...(creatorIds ? { creatorIds } : {}),
  })
}
// Instagram stories for tracked creators. Independent of the other steps —
// nothing downstream reads it — so the UI fires it in parallel. Stories expire
// after 24h, which is why a scheduled version of this runs every 6 hours.
export async function fbStepStories(maxHandles = 60, creatorIds?: string[]) {
  return authedFetch('api_step_stories', {
    brandId: BRAND_ID, maxHandles,
    ...(creatorIds ? { creatorIds } : {}),
  })
}
// fbStepScore removed in productization cleanup — SRS already covers the signal.
export async function fbStepSrs() {
  return authedFetch('api_step_srs', { brandId: BRAND_ID })
}
// Post sentiment over hits that don't have it yet. Batched and resumable, so
// the first pass over a back catalogue takes several calls — the UI fires one
// per scan and lets the backlog drain over subsequent runs.
// Scene definitions + creator classification. Must run BEFORE fbStepSrs: the
// subculture layer reads the links this writes, and a scan that scores before
// classifying leaves the layer redistributed for another cycle. Free — pure
// compute over Firestore, no Gemini, no Apify.
// Refresh Instagram creator profiles: follower counts, bios, avatars. This is
// the ONLY source of Instagram follower counts — post rows carry none — so
// nothing in the UI can show a follower number until this has run.
export async function fbStepProfiles(limit = 500) {
  return authedFetch('api_step_profiles', { brandId: BRAND_ID, limit })
}

export async function fbStepSubcultures() {
  return authedFetch('api_step_subcultures', { brandId: BRAND_ID })
}
// The people around recent hits become discovery candidates and graph edges.
// Free to re-run (reads Firestore only); must precede SRS, which reads the
// edges this writes.
export async function fbStepAudience() {
  return authedFetch('api_step_audience', { brandId: BRAND_ID })
}
export async function fbStepSentiment(limit = 400) {
  return authedFetch('api_step_sentiment', { brandId: BRAND_ID, limit })
}

// ────────────── Brand settings (write via Cloud Function) ──────────────

export type BrandDoc = {
  id: string
  name?: string
  slug?: string
  website?: string
  visualIdentity?: string
  wordmarkAliases?: string[]
  productLines?: Record<string, string>
  confidenceMin?: number
  embeddingThreshold?: number
  dailyBudgetUsd?: number
  storiesAutoScan?: boolean
  dailyAutoScan?: boolean
  hashtagYield?: Record<string, number>
  visualCentroidComputedAt?: string | null
  visualCentroidRefCount?: number
}

export async function fbGetBrand(brandId = BRAND_ID): Promise<BrandDoc | null> {
  const snap = await getDoc(doc(fbDb, 'brands', brandId))
  if (!snap.exists()) return null
  const x = snap.data()
  return {
    id: snap.id,
    name: x.name,
    slug: x.slug,
    website: x.website,
    visualIdentity: x.visualIdentity,
    wordmarkAliases: x.wordmarkAliases,
    productLines: x.productLines,
    confidenceMin: x.confidenceMin,
    embeddingThreshold: x.embeddingThreshold,
    dailyBudgetUsd: x.dailyBudgetUsd,
    storiesAutoScan: x.storiesAutoScan === true,
    dailyAutoScan: x.dailyAutoScan === true,
    hashtagYield: x.hashtagYield,
    visualCentroidComputedAt:
      x.visualCentroidComputedAt instanceof Timestamp
        ? x.visualCentroidComputedAt.toDate().toISOString()
        : null,
    visualCentroidRefCount: x.visualCentroidRefCount,
  }
}

export async function fbUpdateBrandSettings(
  patch: Partial<BrandDoc>,
  opts?: { hashtagPool?: { tag: string; platform: 'instagram' | 'tiktok'; priority: number; active: boolean }[]; replaceHashtags?: boolean },
) {
  return authedFetch('api_brand_settings_update', {
    brandId: BRAND_ID,
    patch,
    hashtagPool: opts?.hashtagPool,
    replaceHashtags: opts?.replaceHashtags,
  })
}

// ────────────── Brand members (access control) ──────────────

export type BrandMember = {
  uid: string
  email: string | null
  role: 'owner' | 'member' | string
  addedAt: string | null
  isYou: boolean
}

export async function fbListMembers(): Promise<BrandMember[]> {
  const r = await authedFetch('api_brand_members', { brandId: BRAND_ID, action: 'list' })
  return (r.members ?? []) as BrandMember[]
}

/** Grant access. The person must have signed in at least once — membership
 *  keys on the Firebase uid, which doesn't exist until then. The server says
 *  so explicitly rather than silently doing nothing. */
export async function fbAddMember(email: string, role: 'member' | 'owner' = 'member'): Promise<BrandMember[]> {
  const r = await authedFetch('api_brand_members', { brandId: BRAND_ID, action: 'add', email, role })
  return (r.members ?? []) as BrandMember[]
}

export async function fbRemoveMember(uid: string): Promise<BrandMember[]> {
  const r = await authedFetch('api_brand_members', { brandId: BRAND_ID, action: 'remove', uid })
  return (r.members ?? []) as BrandMember[]
}

export async function fbRecomputeCentroid() {
  return authedFetch('api_recompute_centroid', { brandId: BRAND_ID })
}

// ────────────── Hashtag pool reads ──────────────

export type HashtagPoolEntry = {
  id: string
  tag: string
  platform: 'instagram' | 'tiktok'
  priority: number
  active: boolean
  /** Budget family (lib/hashtags.py FAMILIES + "custom"); null on legacy docs. */
  family: string | null
  /** Per-scan Apify result cap; null = scrapes at the caller's full per_tag. */
  maxResults: number | null
  /** "hashtag" | "keyword" — keyword is data-model prep, nothing scrapes it yet. */
  kind: string | null
}

export async function fbListHashtagPool(brandId = BRAND_ID): Promise<HashtagPoolEntry[]> {
  const snap = await getDocs(collection(fbDb, 'brands', brandId, 'hashtagPool'))
  return snap.docs.map((d) => {
    const x = d.data()
    return {
      id: d.id,
      tag: x.tag ?? '',
      platform: x.platform ?? 'instagram',
      priority: x.priority ?? 5,
      active: x.active ?? true,
      // Absent on pre-taxonomy docs; the Settings UI shows them as unknown
      // rather than inventing a default the backend never wrote.
      family: (x.family as string | null) ?? null,
      maxResults: (x.maxResults as number | null) ?? null,
      kind: (x.kind as string | null) ?? null,
    }
  })
}

// ────────────── Creator projects ──────────────

export type Project = {
  id: string
  name: string
  note: string | null
  trackingTier: 'tier_1' | 'tier_2'
  creatorIds: string[]
  archived: boolean
  createdBy: string | null
  createdAt: string | null
  updatedAt: string | null
  /** Set when this project is an EVENT: 'YYYY-MM-DD', or null when it is just a
   *  shortlist. A calendar day, not an instant — a festival day has no timezone
   *  of its own, and every comparison here is lexicographic on ISO text. */
  startsAt: string | null
  endsAt: string | null
  /** Tags that find this event's content, as the platforms spell them: no '#',
   *  lowercase. Empty on a project that is not an event. */
  hashtags: string[]
}

function mapProject(id: string, x: Record<string, unknown>): Project {
  const ts = (v: unknown) => {
    const d = v as { toDate?: () => Date } | null
    return d?.toDate ? d.toDate().toISOString() : null
  }
  return {
    id,
    name: (x.name as string) ?? '(naamloos)',
    note: (x.note as string | null) || null,
    trackingTier: (x.trackingTier as Project['trackingTier']) ?? 'tier_1',
    creatorIds: (x.creatorIds as string[] | undefined) ?? [],
    archived: !!x.archived,
    createdBy: (x.createdBy as string | null) ?? null,
    createdAt: ts(x.createdAt),
    updatedAt: ts(x.updatedAt),
    // Already strings server-side. Sliced anyway: a doc written by hand, or by
    // an older client that stored a Timestamp here, must not put an instant
    // where the rest of the app compares calendar days.
    startsAt: (x.startsAt as string | null)?.slice(0, 10) || null,
    endsAt: (x.endsAt as string | null)?.slice(0, 10) || null,
    hashtags: (x.hashtags as string[] | undefined) ?? [],
  }
}

export async function fbListProjects(brandId = BRAND_ID): Promise<Project[]> {
  const snap = await getDocs(collection(fbDb, 'brands', brandId, 'projects'))
  return snap.docs
    .map((d) => mapProject(d.id, d.data()))
    .sort((a, b) => Number(a.archived) - Number(b.archived) || a.name.localeCompare(b.name))
}

/** All writes go through api_projects — membership-gated server-side, because
 * adding a creator to a project changes their scan cadence, which is spend. */
export async function fbProjectsAction(
  action: 'create' | 'rename' | 'archive' | 'unarchive' | 'addCreators' | 'removeCreators',
  params: {
    projectId?: string; name?: string; note?: string; trackingTier?: string
    creatorIds?: string[]
    // Event fields. Omit to leave alone; pass null to clear. 'YYYY-MM-DD'.
    startsAt?: string | null; endsAt?: string | null; hashtags?: string[]
    // addCreators only: {compositeId: displayName} from list imports, so a
    // roster shows real names before the first profile refresh.
    names?: Record<string, string>
  },
  brandId = BRAND_ID,
): Promise<Project> {
  const out = await authedFetch('api_projects', { brandId, action, ...params }) as { project: Record<string, unknown> & { id: string } }
  return mapProject(out.project.id, out.project)
}

// ────────────── Daily usage ──────────────

export type UsageDay = {
  /** YYYY-MM-DD, the Firestore doc id (fs.usage_doc writes one doc per UTC day). */
  day: string
  counters: Record<string, number>
  estimatedSpendUsd: number
  lines: SpendLine[]
}

/**
 * Daily usage, priced from lib/costs.ts.
 *
 * This function used to carry its OWN price table, and it was the model the
 * backend had already corrected: $0.10 for an Apify run (they are free) while
 * omitting apify_ig_results ($2.30/1k) entirely, and Gemini at 0.00075 instead
 * of 0.00175. It under-reported Apify spend by roughly 11x. Nothing ever
 * called it, which is the only reason the wrong number never reached a screen.
 * The table now lives in one place and a Python test fails on any drift.
 */
export async function fbListUsage(days = 14, brandId = BRAND_ID): Promise<UsageDay[]> {
  const snap = await getDocs(
    query(collection(fbDb, 'brands', brandId, 'usage'), orderBy('__name__', 'desc'), fsLimit(days)),
  )
  return snap.docs.map((d) => {
    const counters: Record<string, number> = {}
    for (const [k, v] of Object.entries(d.data())) {
      if (typeof v === 'number') counters[k] = v
    }
    const { total, lines } = spendBreakdown(counters)
    return { day: d.id, counters, estimatedSpendUsd: total, lines }
  })
}

// ────────────── Inbox subscription ──────────────

export type InboxItem = {
  id: string
  type: 'tier1_hit' | 'spike' | 'scan_complete' | 'review_pending' | string
  brandId: string
  body: string
  link?: string | null
  meta?: Record<string, unknown>
  read: boolean
  createdAt: string | null
}

export function fbSubscribeInbox(
  uid: string,
  onChange: (items: InboxItem[]) => void,
): Unsubscribe {
  const q = query(
    collection(fbDb, 'users', uid, 'inbox'),
    orderBy('createdAt', 'desc'),
    fsLimit(50),
  )
  // The error callback matters more than it looks: without one, a rules
  // change or missing index leaves the bell permanently at zero — which is
  // indistinguishable from "no news" and therefore never gets reported.
  return onSnapshot(q, (snap) => {
    onChange(
      snap.docs.map((d) => {
        const x = d.data()
        return {
          id: d.id,
          type: x.type ?? 'event',
          brandId: x.brandId ?? '',
          body: x.body ?? '',
          link: x.link ?? null,
          meta: x.meta ?? {},
          read: !!x.read,
          createdAt: x.createdAt instanceof Timestamp ? x.createdAt.toDate().toISOString() : null,
        }
      }),
    )
  }, (err) => {
    console.error('inbox subscription failed', err)
    onChange([])
  })
}

export type ScanStepKey =
  | 'hashtags' | 'creators' | 'stories' | 'profiles' | 'subcultures' | 'audience' | 'srs' | 'sentiment'

export type ScanStep = {
  state: 'running' | 'done' | 'error'
  startedAt: string | null
  finishedAt: string | null
  error: string | null
  counts: Record<string, number>
}

export type ScanState = {
  startedAt: string | null
  finishedAt: string | null
  // Per-step progress. Absent on a backend that predates it — every consumer
  // must degrade to the flat counters below rather than render a blank panel.
  steps: Partial<Record<ScanStepKey, ScanStep>>
  hashtagQueued: number
  hashtagDone: number
  postsWritten: number
  detectTasksEnqueued: number
  detectionsCompleted: number
  detectionsHit: number
  tags: string[]
  lastActivityAt: string | null
  skippedCount: number
  endReason: string | null
}

function mapScanSteps(raw: unknown): Partial<Record<ScanStepKey, ScanStep>> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Partial<Record<ScanStepKey, ScanStep>> = {}
  for (const [key, v] of Object.entries(raw as Record<string, Record<string, unknown>>)) {
    if (!v || typeof v !== 'object') continue
    const state = v.state
    if (state !== 'running' && state !== 'done' && state !== 'error') continue
    out[key as ScanStepKey] = {
      state,
      startedAt: v.startedAt instanceof Timestamp ? v.startedAt.toDate().toISOString() : null,
      finishedAt: v.finishedAt instanceof Timestamp ? v.finishedAt.toDate().toISOString() : null,
      error: typeof v.error === 'string' ? v.error : null,
      counts: (v.counts && typeof v.counts === 'object' ? v.counts : {}) as Record<string, number>,
    }
  }
  return out
}

export function fbSubscribeScanState(
  onChange: (state: ScanState | null) => void,
  brandId = BRAND_ID,
): Unsubscribe {
  const ref = doc(fbDb, 'brands', brandId)
  return onSnapshot(ref, (snap) => {
    const x = snap.data()
    const s = (x?.scan ?? null) as Record<string, unknown> | null
    if (!s) { onChange(null); return }
    onChange({
      startedAt: s.startedAt instanceof Timestamp ? s.startedAt.toDate().toISOString() : null,
      finishedAt: s.finishedAt instanceof Timestamp ? s.finishedAt.toDate().toISOString() : null,
      steps: mapScanSteps(s.steps),
      hashtagQueued: (s.hashtagQueued as number) ?? 0,
      hashtagDone: (s.hashtagDone as number) ?? 0,
      postsWritten: (s.postsWritten as number) ?? 0,
      detectTasksEnqueued: (s.detectTasksEnqueued as number) ?? 0,
      detectionsCompleted: (s.detectionsCompleted as number) ?? 0,
      detectionsHit: (s.detectionsHit as number) ?? 0,
      tags: (s.tags as string[]) ?? [],
      lastActivityAt: s.lastActivityAt instanceof Timestamp ? s.lastActivityAt.toDate().toISOString() : null,
      skippedCount: (s.skippedCount as number) ?? 0,
      endReason: (s.endReason as string) ?? null,
    })
  }, (err) => {
    // Without this callback a rules change or dropped index makes the scan
    // panel silently blank forever — the exact shape of failure the panel
    // exists to make visible.
    console.error('scan-state subscription failed', err)
    onChange(null)
  })
}

/**
 * Outcome of the last stories sweep, wherever it came from.
 *
 * Deliberately NOT read out of `scan.steps.stories`: that map belongs to a scan
 * session and is wiped when the next one starts, while most sweeps come from
 * the 6-hourly scheduler and have no session at all. Without this, "no stories"
 * and "nothing has looked in a week" render identically.
 */
export type StoriesState = {
  lastRunAt: string | null
  lastFound: number | null
  lastChecked: number | null
  /** Gate that stopped the sweep ("budget", "no_creators"), else null. */
  lastSkipped: string | null
}

export function fbSubscribeStoriesState(
  onChange: (state: StoriesState | null) => void,
  brandId = BRAND_ID,
): Unsubscribe {
  const ref = doc(fbDb, 'brands', brandId)
  return onSnapshot(ref, (snap) => {
    const s = (snap.data()?.stories ?? null) as Record<string, unknown> | null
    if (!s) { onChange(null); return }
    onChange({
      lastRunAt: s.lastRunAt instanceof Timestamp ? s.lastRunAt.toDate().toISOString() : null,
      lastFound: typeof s.lastFound === 'number' ? s.lastFound : null,
      lastChecked: typeof s.lastChecked === 'number' ? s.lastChecked : null,
      lastSkipped: typeof s.lastSkipped === 'string' ? s.lastSkipped : null,
    })
  }, (err) => {
    console.error('stories-state subscription failed', err)
    onChange(null)
  })
}

export async function fbMarkInboxRead(itemId: string) {
  if (!fbAuth.currentUser) return
  const uid = fbAuth.currentUser.uid
  await updateDoc(doc(fbDb, 'users', uid, 'inbox', itemId), { read: true })
}

// ────────────── Debug: detection attempt log + scan runs ──────────────

export type DetectLog = {
  id: string
  postId: string
  imageUrl: string
  outcome: 'wrote' | 'skipped' | 'error' | string
  reason: string
  createdAt: string | null
  detected?: boolean
  cosine?: number
  threshold?: number
  term?: string
  errMsg?: string
  confidence?: number | null
  productLine?: string | null
  hint?: string
  ocrText?: string
  geminiContext?: string
  centroidMissing?: boolean
}

export async function fbListDetectLog(limit = 50, brandId = BRAND_ID): Promise<DetectLog[]> {
  const snap = await getDocs(
    query(
      collection(fbDb, 'brands', brandId, 'detectLog'),
      orderBy('createdAt', 'desc'),
      fsLimit(limit),
    ),
  )
  return snap.docs.map((d) => {
    const x = d.data() as Record<string, unknown>
    return {
      id: d.id,
      postId: (x.postId as string) ?? '',
      imageUrl: (x.imageUrl as string) ?? '',
      outcome: (x.outcome as string) ?? 'unknown',
      reason: (x.reason as string) ?? '',
      createdAt: x.createdAt instanceof Timestamp ? x.createdAt.toDate().toISOString() : null,
      detected: x.detected as boolean | undefined,
      cosine: x.cosine as number | undefined,
      threshold: x.threshold as number | undefined,
      term: x.term as string | undefined,
      errMsg: x.errMsg as string | undefined,
      confidence: x.confidence as number | null | undefined,
      productLine: x.productLine as string | null | undefined,
      hint: x.hint as string | undefined,
    }
  })
}

export type ScanRun = {
  id: string
  type: string
  status: string
  stats: Record<string, unknown>
  startedAt: string | null
  finishedAt: string | null
}

export type VideoLog = {
  id: string
  postId: string
  videoUrl: string
  stage: 'received' | 'download' | 'frames' | 'analyse' | 'done' | string
  status: string  // 'ok' | 'failed' | 'hit' | 'no_hit' | 'skipped_budget' | 'no_post' | etc
  createdAt: string | null
  // optional debug fields
  reason?: string
  bytes?: number
  bytesAttempted?: number
  ms?: number
  totalMs?: number
  framesExtracted?: number
  framesAnalysed?: number
  info?: Record<string, unknown>
  frames?: Array<{ idx: number; source?: string; detected?: boolean; err?: string }>
  hitFrame?: { frame_idx: number; source?: string } | null
}

export async function fbListVideoLog(limit = 100, brandId = BRAND_ID): Promise<VideoLog[]> {
  const snap = await getDocs(
    query(
      collection(fbDb, 'brands', brandId, 'videoLog'),
      orderBy('createdAt', 'desc'),
      fsLimit(limit),
    ),
  )
  return snap.docs.map((d) => {
    const x = d.data() as Record<string, unknown>
    return {
      id: d.id,
      postId: (x.postId as string) ?? '',
      videoUrl: (x.videoUrl as string) ?? '',
      stage: (x.stage as string) ?? 'received',
      status: (x.status as string) ?? '',
      createdAt: x.createdAt instanceof Timestamp ? x.createdAt.toDate().toISOString() : null,
      reason: x.reason as string | undefined,
      bytes: x.bytes as number | undefined,
      bytesAttempted: x.bytesAttempted as number | undefined,
      ms: x.ms as number | undefined,
      totalMs: x.totalMs as number | undefined,
      framesExtracted: x.framesExtracted as number | undefined,
      framesAnalysed: x.framesAnalysed as number | undefined,
      info: x.info as Record<string, unknown> | undefined,
      frames: x.frames as VideoLog['frames'],
      hitFrame: (x.hitFrame as VideoLog['hitFrame']) ?? null,
    }
  })
}

export type ScrapeLog = {
  id: string
  tag: string
  platform: 'instagram' | 'tiktok' | string
  itemsReturned: number
  error?: string
  source: 'scan_hashtags' | 'scan_creators' | string
  createdAt: string | null
  breakdown?: {
    kinds?: Record<string, number>
    hasVideoUrl?: number
    hasDisplayUrl?: number
    hasDownloadAddr?: number
  }
  sampleKeys?: string[]
  sample?: Record<string, unknown>
  diag?: {
    landedUrl?: string | null
    captchaDetected?: boolean
    itemListResponses?: number
    itemListNonOk?: number
    itemListZero?: number
    detailResponseSeen?: boolean
    landedTitle?: string | null
    blockedReason?: string | null
    elapsedMs?: number
    attempts?: number
    transportError?: string | null
    proxy?: string | null
  }
}

export async function fbListScrapeLog(limit = 50, brandId = BRAND_ID): Promise<ScrapeLog[]> {
  const snap = await getDocs(
    query(
      collection(fbDb, 'brands', brandId, 'scrapeLog'),
      orderBy('createdAt', 'desc'),
      fsLimit(limit),
    ),
  )
  return snap.docs.map((d) => {
    const x = d.data() as Record<string, unknown>
    return {
      id: d.id,
      tag: (x.tag as string) ?? '',
      platform: (x.platform as string) ?? '',
      itemsReturned: (x.itemsReturned as number) ?? 0,
      error: x.error as string | undefined,
      source: (x.source as string) ?? '',
      createdAt: x.createdAt instanceof Timestamp ? x.createdAt.toDate().toISOString() : null,
      breakdown: x.breakdown as ScrapeLog['breakdown'],
      sampleKeys: x.sampleKeys as string[] | undefined,
      sample: x.sample as Record<string, unknown> | undefined,
      diag: x.diag as ScrapeLog['diag'],
    }
  })
}

export async function fbListScanRuns(limit = 20, brandId = BRAND_ID): Promise<ScanRun[]> {
  const snap = await getDocs(
    query(
      collection(fbDb, 'brands', brandId, 'scanRuns'),
      orderBy('finishedAt', 'desc'),
      fsLimit(limit),
    ),
  )
  return snap.docs.map((d) => {
    const x = d.data() as Record<string, unknown>
    return {
      id: d.id,
      type: (x.type as string) ?? '',
      status: (x.status as string) ?? '',
      stats: (x.stats as Record<string, unknown>) ?? {},
      startedAt: x.startedAt instanceof Timestamp ? x.startedAt.toDate().toISOString() : null,
      finishedAt: x.finishedAt instanceof Timestamp ? x.finishedAt.toDate().toISOString() : null,
    }
  })
}

export async function fbMarkAllInboxRead(items: InboxItem[]) {
  if (!fbAuth.currentUser) return
  const uid = fbAuth.currentUser.uid
  await Promise.all(
    items.filter((i) => !i.read).map((i) => updateDoc(doc(fbDb, 'users', uid, 'inbox', i.id), { read: true })),
  )
}

// ────────────── Event data: the label AND the window ──────────────
//
// The event pages' live data path, and the reason a scan nobody aimed at an
// event can still land on its page.
//
// TWO QUERIES, UNIONED, because the collections hold two kinds of event row and
// neither one alone is the event:
//
//   1. `eventId` — what 78_upload_event.py pushed. Explicitly labelled, and the
//      only rows that can be UNDATED: matchEvent rule 3 lets a roster creator's
//      undated post through, so something has to carry it, and a range query on
//      postedAt never will.
//   2. THE WINDOW — every post written inside the event's period, whoever wrote
//      it. scheduled_daily_scan and scheduled_stories run on their own clock
//      through scan_creators/scan_hashtags/scan_stories, and those handlers
//      know nothing about events: `grep eventId firebase/functions` hits
//      import_event.py and nothing else. Before this query their output could
//      not appear on an event page however festival it was — the page asked for
//      a label only one manual uploader ever wrote.
//
// ATTRIBUTION IS NOT TAKEN FROM EITHER QUERY. Both feed the same
// matchEvent/evidencedHandlesFor pass in Event.tsx, which decides membership
// from the roster, the window and the tags. `eventId` is a way to FIND rows
// here, never a claim about them — the same rule the rest of the page follows,
// and the reason widening the net cannot inflate a number: a scanned post that
// is not this event is fetched, judged not-this-event, and dropped.
//
// Cached per event AND window for the tab's lifetime: the Lowlands set is ~5K
// docs, and the events LIST page and the event DETAIL page would otherwise each
// pay that read bill on every visit.

export type EventCampaign = { items: CampaignItem[]; detections: DetectionRow[] }

/** Both bounds inclusive, both 'YYYY-MM-DD' — see lib/events.eventWindow. */
export type EventRange = { start: string; end: string }

const eventCampaignCache = new Map<string, Promise<EventCampaign>>()

function mapEventPost(d: QueryDocumentSnapshot<DocumentData>): CampaignItem {
  const x = d.data()
  return {
    itemId: (x.itemId as string) ?? d.id,
    platform: (x.platform as CampaignItem['platform']) ?? 'instagram',
    surface: surfaceOf(x),
    creatorHandle: (x.creatorHandle as string) ?? '',
    platformHandle: (x.platformHandle as string | undefined) ?? undefined,
    url: (x.url as string | null) ?? null,
    coverUrl: (x.coverUrl as string | null) ?? null,
    videoUrl: (x.videoUrl as string | null) ?? null,
    // Same story as the surface: the scanners write contentType, not mediaType.
    mediaType: (x.mediaType as CampaignItem['mediaType'])
      ?? (x.contentType === 'video' || x.videoUrl ? 'video' : 'image'),
    postedAt: tsToIso(x.postedAt),
    caption: (x.caption as string | null) ?? null,
    hashtags: (x.hashtags as string[]) ?? [],
    mentions: (x.mentions as string[]) ?? [],
    videoDuration: (x.videoDuration as number | null) ?? null,
    views: (x.viewsCount as number | null) ?? null,
    likes: (x.likesCount as number | null) ?? null,
    comments: (x.commentsCount as number | null) ?? null,
    shares: (x.sharesCount as number | null) ?? null,
    saves: (x.savesCount as number | null) ?? null,
    pollVotes: (x.pollVotes as number | null) ?? null,
    isPaidPartnership: x.isPaidPartnership === true,
    foundVia: (x.foundVia as string | null) ?? null,
    eventId: (x.eventId as string | null) ?? null,
    scrapedFor: (x.scrapedFor as string | null) ?? null,
    postKey: (x.postKey as string | null) ?? null,
    slot: (x.slot as number | null) ?? null,
    slots: (x.slots as number | null) ?? null,
  }
}

/** Doc id wins over query, so a row found by BOTH queries is one row. */
function dedupeDocs(
  ...snaps: (QuerySnapshot<DocumentData> | null)[]
): QueryDocumentSnapshot<DocumentData>[] {
  const out = new Map<string, QueryDocumentSnapshot<DocumentData>>()
  for (const snap of snaps) for (const d of snap?.docs ?? []) out.set(d.id, d)
  return [...out.values()]
}

/** Forget the cached rows for an event, so the next fetch really goes out.
 *
 *  The cache is what keeps the events LIST page from paying the read bill once
 *  per row, and it is deliberately per-tab-lifetime. But a scan that just
 *  finished wrote new rows, and without this the page would keep serving the
 *  answer it got before the scan ran — "I pressed scan and nothing changed",
 *  arrived at from the opposite direction. */
export function fbClearEventCampaignCache(eventId?: string): void {
  if (!eventId) return eventCampaignCache.clear()
  for (const key of [...eventCampaignCache.keys()]) {
    // Keys are `brand|event|range`; match the event segment exactly so
    // "lowlands-2026" never clears "lowlands-2026-test".
    if (key.split('|')[1] === eventId) eventCampaignCache.delete(key)
  }
}

export function fbFetchEventCampaign(
  eventId: string,
  /** Null means "labelled rows only" — a caller without an event definition. */
  range: EventRange | null = null,
  brandId = BRAND_ID,
): Promise<EventCampaign> {
  const key = `${brandId}|${eventId}|${range ? `${range.start}..${range.end}` : '-'}`
  const cached = eventCampaignCache.get(key)
  if (cached) return cached
  const p = (async () => {
    const postsCol = collection(fbDb, 'brands', brandId, 'posts')
    const detsCol = collection(fbDb, 'brands', brandId, 'detections')
    const bounds = range ? dayBounds(range) : null

    const labelled = (c: CollectionReference<DocumentData>) =>
      getDocs(query(c, where('eventId', '==', eventId), fsLimit(8000)))
    // A window query that fails — a missing index, a rules change — must not
    // take the labelled rows down with it. Losing half the rows is bad; going
    // from "less than everything" to "Nog geen data" is the failure this whole
    // fetcher exists to prevent.
    const windowed = (c: CollectionReference<DocumentData>) =>
      bounds
        ? getDocs(query(c,
            where('postedAt', '>=', Timestamp.fromDate(bounds[0])),
            where('postedAt', '<=', Timestamp.fromDate(bounds[1])),
            fsLimit(8000))).catch(() => null)
        : Promise.resolve(null)

    const [labelPosts, labelDets, winPosts, winDets] = await Promise.all([
      labelled(postsCol), labelled(detsCol),
      windowed(postsCol), windowed(detsCol),
    ])

    const items = dedupeDocs(labelPosts, winPosts).map(mapEventPost)
    const detections = dedupeDocs(labelDets, winDets).map((d) => {
      const row = mapDetection(d, brandId)
      // The event join runs on the fixture-era item id, preserved as itemId on
      // the doc; postId keeps the production shape for the live feed's
      // parentPostKey collapse. Both name the same post. A scanner-written
      // detection has no itemId and its postId IS the post's doc id, which is
      // what mapEventPost falls back to — so the join holds on both paths.
      const itemId = (d.data().itemId as string | null) ?? row.post_id
      return { ...row, post_id: itemId }
    })
    return { items, detections }
  })()
  // A failed fetch must not be cached as "the event is empty".
  p.catch(() => eventCampaignCache.delete(key))
  eventCampaignCache.set(key, p)
  return p
}

export async function fbFetchEventAudience(eventId: string, brandId = BRAND_ID): Promise<Audience | null> {
  try {
    const snap = await getDoc(doc(fbDb, 'brands', brandId, 'eventAudience', eventId))
    if (!snap.exists()) return null
    const data = { ...(snap.data() as Record<string, unknown>) }
    delete data.importedAt
    return data as unknown as Audience
  } catch {
    return null
  }
}
