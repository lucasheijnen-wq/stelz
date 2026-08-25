// "Track in project" — the one control that starts tracking a creator.
//
// Adding a creator to a project is a WRITE WITH A PRICE: the server patches
// their tier to the project's trackingTier, and the scan cadence map turns
// that into up to 8x the scrape frequency. So this goes through api_projects
// (membership-gated, capped server-side per tracking tier) and the button
// hides for read-only users rather than teasing a 403.
//
// This replaces the DetectionDrawer's old "Promote to tier 1" button, which
// had no onClick at all — it shipped as a visual promise with nothing behind
// it.

import { useEffect, useRef, useState } from 'react'
import { Button } from './ui'
import { fetchProjects, projectsAction, type Project } from '../lib/data'
import { useMembership } from '../lib/membershipContext'
export function AddToProject({ creatorId, label = 'Track in project' }: { creatorId: string; label?: string }) {
  const { canWrite } = useMembership()
  const [open, setOpen] = useState(false)
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [newName, setNewName] = useState('')
  const loadedFor = useRef<string | null>(null)

  // Lazy: the projects list is only fetched when the menu opens, and refetched
  // when it opens for a different creator (membership may have changed).
  useEffect(() => {
    if (!open || loadedFor.current === creatorId) return
    loadedFor.current = creatorId
    fetchProjects().then(setProjects).catch(() => setProjects([]))
  }, [open, creatorId])

  if (!canWrite) return null

  const act = async (fn: () => Promise<Project>) => {
    setErr(null)
    try {
      const updated = await fn()
      setProjects((ps) => {
        if (!ps) return ps
        const i = ps.findIndex((p) => p.id === updated.id)
        return i < 0 ? [...ps, updated] : ps.map((p) => (p.id === updated.id ? updated : p))
      })
    } catch (e) {
      // The server's cap message explains itself ("Tracking cap reached: …");
      // show it verbatim instead of translating it into something vaguer.
      setErr((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const toggle = (p: Project) => {
    const inProject = p.creatorIds.includes(creatorId)
    setBusy(p.id)
    void act(() => projectsAction(inProject ? 'removeCreators' : 'addCreators', {
      projectId: p.id, creatorIds: [creatorId],
    }))
  }

  const createAndAdd = async () => {
    const name = newName.trim()
    if (!name) return
    setBusy('_new')
    setErr(null)
    try {
      const created = await projectsAction('create', { name })
      setNewName('')
      setProjects((ps) => (ps ? [...ps, created] : [created]))
      await act(() => projectsAction('addCreators', { projectId: created.id, creatorIds: [creatorId] }))
    } catch (e) {
      setErr((e as Error).message)
      setBusy(null)
    }
  }

  const live = (projects ?? []).filter((p) => !p.archived)

  return (
    <span className="relative inline-block" onClick={(e) => e.stopPropagation()}>
      <Button size="sm" variant="secondary" onClick={() => setOpen((v) => !v)}>{label}</Button>
      {open && (
        <>
          <span className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <span className="absolute left-0 top-full mt-1 z-40 w-64 bg-[var(--color-surface)] border border-[var(--color-border-strong)] block">
            {projects === null ? (
              <span className="block px-3 py-3 text-[12px] text-[var(--color-ink-subtle)]">Loading…</span>
            ) : (
              <>
                {live.length === 0 && (
                  <span className="block px-3 py-2 text-[12px] text-[var(--color-ink-muted)]">
                    No projects yet — create one below.
                  </span>
                )}
                {live.map((p) => {
                  const inProject = p.creatorIds.includes(creatorId)
                  return (
                    <button
                      key={p.id}
                      disabled={busy === p.id}
                      onClick={() => toggle(p)}
                      className="w-full px-3 py-2 text-left text-[13px] hover:bg-[var(--color-bg)] flex items-center justify-between disabled:opacity-50"
                    >
                      <span className="truncate">{p.name}</span>
                      <span className="text-[11px] text-[var(--color-ink-subtle)] shrink-0 ml-2">
                        {inProject ? '✓ tracked' : `${p.creatorIds.length}`}
                      </span>
                    </button>
                  )
                })}
                <span className="flex items-center gap-1.5 border-t border-[var(--color-border)] p-2">
                  <input
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && createAndAdd()}
                    placeholder="New project…"
                    className="flex-1 min-w-0 border border-[var(--color-border)] px-2 h-7 text-[12px] focus:outline-none focus:border-[var(--color-ink)]"
                  />
                  <Button size="sm" variant="primary" disabled={!newName.trim() || busy === '_new'} onClick={createAndAdd}>+</Button>
                </span>
                {err && <span className="block px-3 py-2 text-[11px] text-[var(--color-bad)] border-t border-[var(--color-border)] leading-relaxed">{err}</span>}
              </>
            )}
          </span>
        </>
      )}
    </span>
  )
}
