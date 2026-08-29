// Which rows are the same post — the one question two write paths disagree on.
//
// A post can reach Firestore two ways, and they name it differently:
//
//   IMPORT   tools/stelz_brand_watch/78_upload_event.post_doc_id builds
//            `instagram_<shortCode>` from the local fixture, preserving case:
//            instagram_Da-82n0IfMN.
//   SCANNER  the Cloud Functions build `instagram_<numeric id>` through
//            fs.composite_id, which lowercases: instagram_3944857960016114445.
//
// They cannot collide. The shortcode carries uppercase and composite_id
// lowercases, and the two do not even start from the same field. So the first
// online scan over an already-imported event doubled every roster post — in
// the flattering direction, and invisibly, because the two rows carry
// different ids and different urls and nothing on the page compares them.
//
// Renaming either doc id would split the rows already in Firestore, so instead
// both writers now carry a shared postKey (the shortcode, lowercased) and the
// rows are collapsed on THAT. Rows written before the field existed have no
// postKey and fall back to the doc id, which is the old behaviour exactly —
// they converge as the scanner rewrites them.
//
// Extracted from firestore.ts so vitest can exercise it without initialising
// the Firebase SDK, the same reason functionsDiagnose.ts lives apart.

/** The fields these rules read. Anything Firestore hands back satisfies it. */
export type PostRow = Record<string, unknown>

/**
 * The post's public identity, lowercased — or null when the row does not carry
 * one.
 *
 * Lowercasing is the whole point: an imported row's shortcode is mixed-case
 * and a scanned row's is not, so without it the two never match.
 */
export function postKeyOf(x: PostRow): string | null {
  const pk = typeof x.postKey === 'string' ? x.postKey.trim().toLowerCase() : ''
  if (pk) return pk
  // Carousel slides written before postKey existed still name their parent,
  // and that is enough to collapse the carousel onto one post.
  const parent = typeof x.parentPostId === 'string' ? x.parentPostId.trim().toLowerCase() : ''
  return parent || null
}

/**
 * A carousel slide's position, where the first slide is 0 — or null when the
 * row is not a slide of anything.
 *
 * Reads both names: `slot` is what the fixture writes, `carouselSlot` what the
 * sidecar writer has always written.
 *
 * THE `slots <= 1` RULE IS LOAD-BEARING. The fixture stamps every single-image
 * post with slot 0 / slots 1, while the scanner writes no slot at all for the
 * same post. Taking that 0 at face value gives the two rows different dedupe
 * keys, and single posts — the overwhelming majority of the archive — would
 * double instead of collapse. A post with one slide has no meaningful slot, so
 * both spellings must resolve to null.
 */
export function slotOf(x: PostRow): number | null {
  // Only a genuine multi-slide carousel has positions worth distinguishing.
  if (typeof x.slots === 'number' && x.slots <= 1) return null
  if (typeof x.slot === 'number') return x.slot
  if (typeof x.carouselSlot === 'number') return x.carouselSlot
  return null
}

/**
 * The key two rows must share to be treated as the same row.
 *
 * postKey ALONE would be wrong: every slide of a carousel shares it, and
 * collapsing on it here would throw away nine slides of media for a
 * ten-slide post. The slot is what keeps them apart as documents while the
 * rollups still count them as one post (see joinCampaign's postKey).
 */
export function dedupeKeyOf(id: string, x: PostRow): string {
  const pk = postKeyOf(x)
  if (!pk) return id
  const slot = slotOf(x)
  return `pk:${pk}|${slot ?? ''}`
}
