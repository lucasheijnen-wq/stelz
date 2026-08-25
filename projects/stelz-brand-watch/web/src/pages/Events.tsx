// The list of events, and the way to add one.
//
// This tab used to be called "Lowlands". The festival's name was in the route,
// the copy and the component, which works exactly once — and Stëlz does more
// than one festival a year. What the tab is actually FOR is: a period, a venue,
// a roster of creators booked for it, and the two questions that follow.
//
//   Did the people we booked deliver?      A contract question. Silence from
//                                          someone being paid is the finding.
//   Is the can showing up on its own?      A marketing question. Here silence
//                                          means nothing and one sighting means
//                                          a lot.
//
// Those two are never added together, on this page or any other.

import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Card, PageShell } from '../components/ui'
import { EVENTS, type StelzEvent } from '../data/events'
import { eventStatus, evidencedHandlesFor, formatWindow, matchEvent } from '../lib/events'
import { joinCampaign, type CampaignItem } from '../lib/campaign'
import { isStelzStory } from '../lib/storyStats'
import { fetchProjects, type Project } from '../lib/data'
import { TOTAL_TRACKED_CAP, trackedCreators } from '../lib/projects'
import { useMembership } from '../lib/membershipContext'
import { useEventCampaign } from '../lib/eventData'
import { fmtNum } from '../lib/format'

const STATUS_TONE: Record<string, string> = {
  live: 'bg-[var(--color-good)] text-white',
  aankomend: 'bg-[var(--color-accent)] text-white',
  afgelopen: 'bg-[var(--color-ink)]/60 text-white',
}

export default function EventsPage() {
  const { canWrite } = useMembership()
  const [projects, setProjects] = useState<Project[] | null>(null)
  const [adding, setAdding] = useState(false)

  useEffect(() => {
    fetchProjects().then(setProjects).catch(() => setProjects([]))
  }, [])

  return (
    <PageShell
      title="Evenementen"
      subtitle="Festivals en activaties, met de creators die ervoor geboekt zijn"
      actions={canWrite ? (
        <button
          onClick={() => setAdding((v) => !v)}
          className="text-[12px] px-3 py-1.5 border border-[var(--color-border)] hover:border-[var(--color-ink)] transition-colors"
        >
          {adding ? 'Sluiten' : 'Evenement toevoegen'}
        </button>
      ) : undefined}
    >
      {adding && <NewEvent projects={projects ?? []} />}

      <div className="space-y-3">
        {EVENTS.map((ev) => (
          <EventRow
            key={ev.id}
            ev={ev}
            project={projects?.find((p) => p.id === ev.projectId) ?? null}
          />
        ))}
      </div>

      {EVENTS.length === 0 && (
        <Card className="p-12 text-center text-[13px] text-[var(--color-ink-muted)]">
          Nog geen evenementen.
        </Card>
      )}
    </PageShell>
  )
}

function EventRow({ ev, project }: {
  ev: StelzEvent; project: Project | null
}) {
  const status = eventStatus(ev)
  // Each row fetches its own event's campaign (preview in dev, the imported
  // Firestore rows in production — see lib/eventData). Before this the list
  // could only see the preview fixture, so production showed 0 / 0 / 0 over a
  // fully harvested festival.
  const { items, detections } = useEventCampaign(ev.id)
  const rows = useMemo(
    () => joinCampaign(items ?? ([] as CampaignItem[]), detections),
    [items, detections],
  )
  // Counted through matchEvent, the same function the event page uses. Two
  // implementations of "does this belong to Lowlands" is how a list and a
  // detail page come to disagree about the same festival.
  const stats = useMemo(() => {
    let roster = 0, discovery = 0, hits = 0
    // Same account-evidence set as the detail page, or the two disagree the
    // moment a festival-goer's untagged clip counts there and not here.
    const evidenced = evidencedHandlesFor(ev, rows)
    for (const r of rows) {
      const m = matchEvent(ev, r, evidenced)
      if (!m) continue
      if (m.source === 'roster') roster += 1
      else discovery += 1
      if (isStelzStory(r.verdict)) hits += 1
    }
    return { roster, discovery, hits }
  }, [ev, rows])

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <Link
              to={`/evenementen/${ev.id}`}
              className="stelz-display text-[20px] leading-none text-[var(--color-ink)] hover:underline"
            >
              {ev.name}
            </Link>
            <span className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 ${STATUS_TONE[status]}`}>
              {status}
            </span>
          </div>
          <div className="text-[12px] text-[var(--color-ink-subtle)]">
            {formatWindow(ev)} · {ev.venue}
          </div>
          <div className="text-[12px] text-[var(--color-ink-muted)] mt-2">
            {ev.roster.length} creators geboekt
            {project && project.creatorIds.length !== ev.roster.length && (
              <span className="text-[var(--color-warn)]">
                {' '}· {project.creatorIds.length} profielen gevolgd
              </span>
            )}
            {' · '}{ev.hashtags.length} hashtags
          </div>
        </div>
        <div className="flex gap-6 text-right shrink-0">
          <Figure value={stats.hits} label="met Stëlz" />
          <Figure value={stats.roster} label="van de roster" />
          <Figure value={stats.discovery} label="los gevonden" />
        </div>
      </div>
    </Card>
  )
}

function Figure({ value, label }: { value: number; label: string }) {
  return (
    <div>
      <div className="stelz-display text-[20px] leading-none text-[var(--color-ink)] tabular-nums">
        {fmtNum(value)}
      </div>
      <div className="text-[10px] text-[var(--color-ink-subtle)] mt-1">{label}</div>
    </div>
  )
}

/** The add-an-event form.
 *
 *  IT DOES NOT SAVE YET, AND IT SAYS SO. Creating an event means two writes:
 *  a project document (api_projects now accepts startsAt / endsAt / hashtags)
 *  and an entry in src/data/events/, which is what the harvesters read. The
 *  first needs the Cloud Functions deployed, which they are not; the second is
 *  a file in the repo. A button that appeared to work and silently did neither
 *  would be worse than no button — so this shows exactly what to write and
 *  where, and stops pretending. */
function NewEvent({ projects }: { projects: Project[] }) {
  const [name, setName] = useState('')
  const [venue, setVenue] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [tags, setTags] = useState('')

  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  const invalid = start && end && end < start

  // The tracking caps are GLOBAL — 150 distinct creators across every live
  // project, any tier, and 25 on tier_1. Four events of 28 people is 112; the
  // sixth fails at import with a server error and no warning beforehand. Better
  // to see the remaining room while deciding how many creators to book.
  const tracked = trackedCreators(projects)
  const room = TOTAL_TRACKED_CAP - tracked.size

  const json = JSON.stringify({
    id: slug || 'nieuw-evenement',
    name: name || 'Naam',
    projectId: (name || 'naam').toLowerCase(),
    venue: venue || 'Locatie',
    window: { start: start || 'JJJJ-MM-DD', end: end || 'JJJJ-MM-DD', preDays: 3, postDays: 7 },
    roster: [],
    hashtags: tags.split(/[,\s]+/).filter(Boolean)
      .map((t) => ({ tag: t.replace(/^#/, '').toLowerCase(), family: 'event' })),
    discovery: { perTag: 40, perBrandTag: 200, instagramEventTags: false },
  }, null, 2)

  return (
    <Card className="p-5 mb-4">
      <h2 className="text-[15px] text-[var(--color-ink)] mb-1">Nieuw evenement</h2>
      <p className="text-[12px] text-[var(--color-ink-subtle)] leading-relaxed max-w-2xl mb-4">
        Een evenement bestaat op twee plekken: een project in de database (dat de creators
        volgt) en een definitie in de repo (die de scrapers lezen). Opslaan vanuit de UI kan
        pas als de Cloud Functions zijn uitgerold. Tot die tijd levert dit formulier het
        JSON-blok dat je in{' '}
        <code className="text-[11px] bg-[var(--color-surface-2)] px-1 py-0.5">
          web/src/data/events/
        </code>{' '}
        zet — zichtbare stap in plaats van een knop die niets doet.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4 max-w-2xl">
        <Field label="Naam" value={name} onChange={setName} placeholder="Lowlands 2027" />
        <Field label="Locatie" value={venue} onChange={setVenue} placeholder="Walibi Holland" />
        <Field label="Begint" value={start} onChange={setStart} placeholder="2027-08-20" />
        <Field label="Eindigt" value={end} onChange={setEnd} placeholder="2027-08-23" />
        <div className="sm:col-span-2">
          <Field label="Hashtags" value={tags} onChange={setTags} placeholder="lowlands lowlands2027" />
        </div>
      </div>
      {invalid && (
        <p className="text-[12px] text-[var(--color-bad)] mb-3">
          De einddatum ligt vóór de begindatum.
        </p>
      )}
      <p className={`text-[12px] leading-relaxed max-w-2xl mb-3 ${
        room <= 0 ? 'text-[var(--color-bad)]'
          : room < 30 ? 'text-[var(--color-warn)]' : 'text-[var(--color-ink-subtle)]'
      }`}>
        {room > 0
          ? `Nog ruimte voor ${fmtNum(room)} creators. `
          : 'Geen ruimte meer. '}
        Er worden nu {fmtNum(tracked.size)} van maximaal {fmtNum(TOTAL_TRACKED_CAP)} creators
        gevolgd, over alle actieve projecten heen — de grens is een uitgavenplafond en geldt
        niet per evenement. Een evenement archiveren geeft de ruimte terug.
      </p>
      <pre className="text-[11px] bg-[var(--color-surface-2)] p-3 overflow-x-auto leading-relaxed">
        {json}
      </pre>
      <p className="text-[11px] text-[var(--color-ink-subtle)] mt-3 leading-relaxed">
        Daarna oogsten met{' '}
        <code>--event {slug || 'nieuw-evenement'}</code> in 62, 70, 71 en 73, en analyseren met{' '}
        <code>74_analyse.py --event {slug || 'nieuw-evenement'} --archive … --max-dim 0</code>.
      </p>
    </Card>
  )
}

function Field({ label, value, onChange, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; placeholder: string
}) {
  return (
    <label className="block">
      <span className="block text-[10px] uppercase tracking-widest text-[var(--color-ink-subtle)] mb-1">
        {label}
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full text-[12px] px-2.5 py-1.5 border border-[var(--color-border)] bg-transparent focus:border-[var(--color-ink)] outline-none"
      />
    </label>
  )
}

