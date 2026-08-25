// Who is allowed to change things, and what the UI does about it.
//
// The app is handed to testers with any Google account. Reading is open to
// them by design — that IS the test. Writing is not: rejecting a detection or
// deleting a reference image changes what the detector learns, permanently and
// for everyone. Both are gated server-side on brand membership
// (main.py._require_brand_member, firestore.rules). This module mirrors that
// gate in the UI so a non-member sees "read-only" instead of discovering it
// through a 403 after the click.
//
// The mirror is cosmetic. Anything that relies on `canWrite` for safety rather
// than for clarity is a bug — the server is the authority.

import { useEffect, useState, type ReactNode } from 'react'
import { MembershipCtx, useMembership } from './membershipContext'
import { fbIsBrandMember, fbBrandHasMembers } from './firestore'
import { useAuth } from './authContext'
import { useResetOn } from './useResetOn'

export function MembershipProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth()
  const [isMember, setIsMember] = useState<boolean | undefined>(undefined)
  const [brandUnclaimed, setBrandUnclaimed] = useState(false)

  // A different account — or none — invalidates the previous answer, so it goes
  // back to "unknown" rather than lingering. During render: `canWrite` gates
  // admin-only nav and pages, and an effect would leave the previous user's
  // answer standing for one painted frame after a switch.
  useResetOn(user?.uid, () => {
    setIsMember(undefined)
    setBrandUnclaimed(false)
  })

  useEffect(() => {
    if (!user) return
    let cancelled = false
    fbIsBrandMember(user.uid)
      .then(async (ok) => {
        if (cancelled) return
        setIsMember(ok)
        // Only worth asking when we are NOT a member: a member proves the
        // brand is claimed, so the second read would be pure waste.
        if (!ok) {
          const claimed = await fbBrandHasMembers()
          if (!cancelled) setBrandUnclaimed(!claimed)
        } else {
          setBrandUnclaimed(false)
        }
      })
      .catch(() => { if (!cancelled) { setIsMember(false); setBrandUnclaimed(false) } })
    return () => { cancelled = true }
  }, [user])

  return (
    <MembershipCtx.Provider value={{ isMember, canWrite: isMember === true, brandUnclaimed }}>
      {children}
    </MembershipCtx.Provider>
  )
}

/** Banner shown once per page for read-only visitors. */
export function ReadOnlyNotice() {
  const { isMember, brandUnclaimed } = useMembership()
  if (isMember !== false || brandUnclaimed) return null
  return (
    <div className="mb-6 border border-[var(--color-border-strong)] bg-[var(--color-surface)] px-4 py-3 text-[12px] leading-relaxed">
      <span className="uppercase tracking-[0.12em] text-[10px] font-medium text-[var(--color-accent)] mr-2">
        Read-only
      </span>
      You can browse and open everything. Actions that would change the live
      data — rejecting a hit, editing reference images, starting a scan — are
      disabled for your account. Nothing you click here can affect what the
      detector learns.
    </div>
  )
}
