// De context en de hook, los van de provider.
//
// Ze stonden in lib/membership.tsx, dat ook een component exporteert. Een
// bestand met beide kost Fast Refresh: elke bewerking herlaadt de pagina in
// plaats van het component te verversen. De provider importeert de context
// hiervandaan, dus er is nog steeds precies een van.

import { createContext, useContext } from 'react'

export type Membership = {
  /** Undefined while the check is in flight — render neither state yet. */
  isMember: boolean | undefined
  /** Convenience: false while loading, so buttons start disabled, not enabled. */
  canWrite: boolean
  /**
   * The brand has no members at all, so it is up for grabs. The first caller of
   * bootstrap becomes its owner — which is why this exists: the Run scan button
   * is what calls bootstrap, so hiding it from non-members would leave a fresh
   * brand with no way for anyone to ever claim it.
   */
  brandUnclaimed: boolean
}

export const MembershipCtx = createContext<Membership>({ isMember: undefined, canWrite: false, brandUnclaimed: false })

export function useMembership(): Membership {
  return useContext(MembershipCtx)
}
