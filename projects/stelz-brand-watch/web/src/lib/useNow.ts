// The clock, as a value React is allowed to depend on.
//
// WHY THIS EXISTS. Several panels answer questions of the form "has it been
// more than five minutes", "did this finish within six hours", "which half of
// the window is this in". Written the obvious way that is `Date.now()` in the
// render body, and it is wrong twice over:
//
//   1. It makes render impure. React may render a component more than once for
//      one commit, and under concurrent rendering it may start a render, throw
//      it away and start again. Two reads of the clock in one commit can
//      disagree, so a "stalled" pill and the text under it can end up computed
//      against different moments. react-hooks/purity is the rule that catches
//      it, and it is not a style rule.
//
//   2. It quietly does not work. A value read during render only changes when
//      something else causes a re-render. The scan panel's "no worker has
//      written for five minutes" test therefore never fired on its own: the
//      condition became true while nothing on the page was changing, which is
//      exactly the situation it exists to detect. It flipped only if the user
//      happened to click something.
//
// So the clock goes in state and a timer advances it. That is the whole hook.
//
// PICK THE INTERVAL FROM WHAT IS BEING DECIDED, not from what feels responsive.
// A six-hour cutoff does not need a five-second timer; every tick is a render
// of everything below it. Roughly: the smallest visible step of whatever the
// value drives.

import { useEffect, useState } from 'react'

/**
 * Current epoch milliseconds, refreshed every `everyMs`.
 *
 * The initial value comes from a lazy initialiser, so the first render already
 * has a real time rather than a zero that flashes wrong for one frame.
 */
export function useNow(everyMs = 5_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    // setState from a TIMER, not from the effect body: this is the sanctioned
    // shape. The effect subscribes to an external source — the clock — and
    // writes only when that source produces something new.
    const t = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(t)
  }, [everyMs])
  return now
}
