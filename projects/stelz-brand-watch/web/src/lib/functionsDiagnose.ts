// Why a Cloud Functions POST failed, decided from evidence instead of guessed.
//
// In its own module — not in firestore.ts where its only caller lives — for
// the same reason authContext.ts was pulled out of auth.tsx: importing
// anything from firestore.ts initialises the whole Firebase SDK, and this
// mapping has to be testable in vitest without that. See firestore.authedFetch
// for the probes that produce the input and the curl measurements (27 aug)
// the three outcomes rest on.

/** What probing the function's URL with a plain GET (and, failing that, a
 *  no-cors GET) established:
 *
 *  `readable`  the GET came back with readable status — only possible when the
 *              response carried CORS headers, which only our deployed
 *              functions add. The function EXISTS; the POST itself broke off.
 *  `blocked`   the plain GET threw but the no-cors GET resolved — a server
 *              answered something the browser may not show us. That is the
 *              404-without-CORS signature of a function that was merged but
 *              never deployed.
 *  `down`      even the no-cors GET rejected — nothing answered at all. */
export type ProbeOutcome = 'readable' | 'blocked' | 'down'

/** The message for a failed POST, given what the probes found.
 *
 *  The first version of this message guessed — "meestal betekent dit dat de
 *  functie nog niet is uitgerold" — and the third time it fired, the guess was
 *  wrong: the function existed, CORS was fine, the POST had simply broken off,
 *  and the message sent the debugging session in exactly the wrong direction.
 *  Each branch now states only what the probes proved. */
export function diagnoseUnreachable(path: string, probe: ProbeOutcome): string {
  if (probe === 'readable') {
    // For the scan steps this matters more than it looks: the function keeps
    // running server-side after the connection drops, so an aborted POST is
    // not a failed scan — the progress stream is the truth about that.
    return (
      `${path} bestaat en antwoordt, maar dit verzoek is afgebroken. ` +
      `Als de stap al gestart was, loopt hij op de server gewoon door — ` +
      `het voortgangspaneel laat dat zien. Zo niet: probeer het opnieuw.`
    )
  }
  if (probe === 'blocked') {
    return (
      `${path} bestaat niet in productie: de server antwoordt, maar deze ` +
      `functie is er niet (een 404 zonder CORS-header). Ze is gemerged maar ` +
      `nog niet uitgerold — dat vraagt een functions-deploy.`
    )
  }
  return `${path} is niet bereikbaar: geen netwerkverbinding.`
}
