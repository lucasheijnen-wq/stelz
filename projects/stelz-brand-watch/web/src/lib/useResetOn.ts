// "Forget what was selected, we are looking at something else now."
//
// The mobile nav closes when the route changes. The detection drawer drops its
// chosen frame when a different detection opens. A draft field re-syncs when
// the saved value changes underneath it. Same shape every time: one piece of
// state is only meaningful for one subject, and when the subject changes it has
// to go back to its default.
//
// WHY NOT AN EFFECT. The obvious spelling is
//
//     useEffect(() => { setActiveFrame(null) }, [detection?.detection_id])
//
// and it is wrong in a way that is visible. An effect runs AFTER the browser
// has painted, so there is one frame in which the new detection is on screen
// with the previous one's selected frame still highlighted. React then re-
// renders and it flicks. The heavier the subtree, the longer that frame lasts.
// It is also a cascading render: two passes where one would do.
//
// React's documented answer is to adjust the state DURING render — the pass is
// abandoned and restarted before anything is painted, so the wrong combination
// is never shown. It looks alarming and is not: setState during a component's
// own render is supported precisely for this, and it is why
// react-hooks/set-state-in-effect flags the effect version.
//
// WHAT THIS IS NOT FOR: talking to anything outside React. Subscriptions,
// timers, fetches and event listeners are what effects are for, and they stay
// effects.

import { useState } from 'react'

/**
 * Calls `reset` during render whenever `key` changes identity.
 *
 * `key` is compared with Object.is, so pass a primitive — an id, a pathname, a
 * number. An object or array literal is a new value on every render and would
 * reset on every render, which is an infinite loop rather than a subtle bug.
 */
export function useResetOn(key: unknown, reset: () => void): void {
  const [seen, setSeen] = useState(key)
  if (!Object.is(seen, key)) {
    setSeen(key)
    reset()
  }
}
