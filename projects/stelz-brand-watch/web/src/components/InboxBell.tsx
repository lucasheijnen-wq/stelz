// In-app inbox bell. Subscribes to /users/{uid}/inbox and surfaces tier-1
// hits, spikes, scan-complete events as a sidebar dropdown.

import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../lib/authContext'
import { fbSubscribeInbox, fbMarkInboxRead, fbMarkAllInboxRead, type InboxItem } from '../lib/firestore'

export function InboxBell() {
  const { user } = useAuth()
  const [items, setItems] = useState<InboxItem[]>([])
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!user) return
    const unsub = fbSubscribeInbox(user.uid, setItems)
    return unsub
  }, [user])

  useEffect(() => {
    function onClickAway(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    if (open) document.addEventListener('mousedown', onClickAway)
    return () => document.removeEventListener('mousedown', onClickAway)
  }, [open])

  const unread = items.filter((i) => !i.read).length

  // Mark-read failures used to be unawaited unhandled rejections: the badge
  // count silently reverted on the next snapshot and nothing said why. The
  // writes stay optimistic (the subscription corrects the list either way);
  // the failure just gets a face now.
  const [markError, setMarkError] = useState<string | null>(null)
  const markAll = () => {
    setMarkError(null)
    fbMarkAllInboxRead(items).catch((e) => setMarkError((e as Error).message))
  }
  const markOne = (id: string) => {
    fbMarkInboxRead(id).catch((e) => setMarkError((e as Error).message))
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative flex items-center justify-center w-8 h-8 hover:bg-white/10 rounded-full"
        aria-label="Inbox"
      >
        <BellIcon />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 bg-[var(--color-accent)] text-white text-[10px] tabular-nums flex items-center justify-center">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-50 w-[340px] max-h-[480px] overflow-y-auto bg-[var(--color-surface)] border border-[var(--color-border)]">
          <div className="sticky top-0 px-4 h-10 flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)]">
            <div className="text-[11px] uppercase tracking-widest text-[var(--color-ink-subtle)]">Inbox</div>
            {unread > 0 && (
              <button onClick={markAll} className="text-[11px] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]">
                Mark all read
              </button>
            )}
          </div>

          {markError && (
            <div className="px-4 py-2 text-[11px] text-[var(--color-bad)] border-b border-[var(--color-border)]">
              Niet opgeslagen: {markError}
            </div>
          )}

          {items.length === 0 ? (
            <div className="px-4 py-8 text-center text-[12px] text-[var(--color-ink-subtle)]">
              Nothing here yet. Detections, spikes and scan completions will appear here.
            </div>
          ) : (
            <ul>
              {items.map((it) => (
                <li
                  key={it.id}
                  onClick={() => {
                    markOne(it.id)
                    if (it.link) window.location.href = it.link
                    setOpen(false)
                  }}
                  className={`px-4 py-3 border-b border-[var(--color-border)] cursor-pointer hover:bg-[var(--color-bg)] ${!it.read ? 'bg-[var(--color-bg)]' : ''}`}
                >
                  <div className="flex items-start gap-2">
                    {!it.read && <span className="mt-1.5 w-1.5 h-1.5 bg-[var(--color-accent)] rounded-full shrink-0" />}
                    <div className="flex-1 min-w-0">
                      <div className="text-[10px] uppercase tracking-widest text-[var(--color-ink-subtle)]">{labelFor(it.type)}</div>
                      <div className="text-[13px] leading-snug mt-0.5">{it.body}</div>
                      <div className="text-[11px] text-[var(--color-ink-subtle)] mt-1 tabular-nums">{timeAgo(it.createdAt)}</div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function labelFor(type: string): string {
  switch (type) {
    case 'tier1_hit': return 'Tier-1 hit'
    case 'spike': return 'Spike'
    case 'scan_complete': return 'Scan complete'
    case 'review_pending': return 'Needs review'
    default: return type
  }
}

function timeAgo(iso: string | null): string {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

function BellIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 2v1" />
      <path d="M4 7a4 4 0 0 1 8 0v3l1 2H3l1-2V7z" />
      <path d="M7 13a1 1 0 0 0 2 0" />
    </svg>
  )
}
