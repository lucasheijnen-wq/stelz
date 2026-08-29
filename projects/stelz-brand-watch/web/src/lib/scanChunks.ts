// How much of a roster one scan request may carry — arithmetic, not taste.
//
// api_step_creators is deployed with timeout_sec=540. Inside it, scan_creators
// scrapes Instagram in batches of ten handles, and each batch is a synchronous
// Apify call whose HTTP read allows 210 seconds (run_sync's timeout=180 plus
// its 30s slack). Two batches fit in a request. Three do not.
//
// The event button used to send the whole roster in one call with
// maxCreators=200. On the deployed backend — which predates creatorIds and so
// runs the brand-wide due queue at that width — that is up to twenty batches:
// the container was killed on the timeout wall, the browser was handed a bare
// TypeError, and the message it produced ("dit verzoek is afgebroken") was
// true and useless. Worse, scan_creators persisted only after its loop, so
// every batch Apify had already billed for died in memory.
//
// The server now writes each batch down as it lands and stops starting batches
// it cannot finish, reporting what is left as `more_remaining`. This module is
// the client half: cut the roster so no single request can reach the wall in
// the first place, and repeat only what the server says it did not reach.
//
// Pure and separate from the component so vitest can check the arithmetic
// without a DOM — same reason functionsDiagnose.ts and postIdentity.ts live
// apart from firestore.ts.

/** Handles per request. One Apify batch, with nothing left over. */
export const CHUNK = 10

/** Split a roster into request-sized pieces. Order is preserved: a partly
 *  scanned roster should resume where a reader would expect it to. */
export function chunksOf<T>(roster: readonly T[], size = CHUNK): T[][] {
  if (size < 1) throw new Error('chunk size must be at least 1')
  const out: T[][] = []
  for (let i = 0; i < roster.length; i += size) out.push(roster.slice(i, i + size))
  return out
}

/**
 * What is left of a chunk after the server reports `more_remaining`.
 *
 * The server counts handles it never STARTED, and it works through a chunk in
 * order, so the remainder is the tail. Returning the tail rather than the
 * whole chunk is what stops a retry from paying Apify twice for the handles
 * that already succeeded.
 *
 * Defensive on both ends: a count of zero or less means done, and a count
 * larger than the chunk (a backend reporting on some other unit) is clamped
 * rather than trusted into a negative slice, which would resend everything.
 */
export function remainderOf<T>(chunk: readonly T[], moreRemaining: unknown): T[] {
  const left = typeof moreRemaining === 'number' && Number.isFinite(moreRemaining)
    ? Math.floor(moreRemaining)
    : 0
  if (left <= 0) return []
  if (left >= chunk.length) return [...chunk]
  return chunk.slice(chunk.length - left)
}
