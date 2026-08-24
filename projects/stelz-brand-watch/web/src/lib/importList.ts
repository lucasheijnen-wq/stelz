// Paste-import parser for creator lists — the "Gasten / Tag Instagram /
// Tag TikTok" spreadsheets a client sends before a campaign. Pure and
// framework-free so the preview table, the seed's pre-flight test and the
// actual import all run the exact same code: what the user approves in the
// preview is literally what gets imported.
//
// Column contract: [name, instagram, tiktok]. Handles may be bare, @-prefixed
// or full profile URLs; "Geen"/"-"/empty mark an absent platform without
// complaint. Anything unparseable becomes a row warning, never a silent drop —
// a roster import that quietly loses a creator is worse than one that asks.

export type ImportRow = {
  line: number
  name: string | null
  instagram: string | null
  tiktok: string | null
  // The cells as pasted, so an editor can show what FAILED to parse for the
  // user to fix, instead of a silently emptied field.
  rawInstagram: string
  rawTiktok: string
  creatorIds: string[]
  warnings: string[]
}

export type ParsedImport = {
  rows: ImportRow[]
  creatorIds: string[]
  names: Record<string, string>
  warnings: string[]
}

// Markers a spreadsheet uses for "this person is not on that platform".
const ABSENT = new Set(['', '-', '–', '—', 'geen', 'nvt', 'n.v.t.', 'none', 'n/a'])

// Instagram/TikTok handle charset. Both platforms are stricter than this in
// places, but anything outside it is certainly wrong.
const HANDLE_RE = /^[a-z0-9._]{1,30}$/

// instagram.com path heads that are content links, not profiles.
const IG_NON_PROFILE = new Set(['p', 'reel', 'reels', 'stories', 'explore', 'tv', 'accounts'])

export function extractHandle(
  raw: string,
  platform: 'instagram' | 'tiktok',
): { handle: string | null; warning: string | null } {
  // Zero-width characters ride along with copy-paste from Sheets.
  //
  // ESCAPES, NOT THE CHARACTERS THEMSELVES. This class used to hold the four
  // literal code points, which meant the line that strips invisible characters
  // was itself invisible: unreadable in review, unfindable with grep, and one
  // editor "clean up whitespace" or over-eager git filter away from becoming
  // `[]` — a class that matches nothing, silently ending the cleanup while the
  // code still looks correct. U+200B zero-width space, U+200C non-joiner,
  // U+200D joiner, U+FEFF byte-order mark.
  //
  // An alternation rather than a character class, because inside a class the
  // adjacent pair U+200C U+200D is ambiguous to a reader and to the linter: it
  // could mean "either of these two" or "this one two-character sequence".
  // Written as | it is unmistakably the first.
  const cleaned = raw.replace(/\u200B|\u200C|\u200D|\uFEFF/g, '').trim()
  if (ABSENT.has(cleaned.toLowerCase())) return { handle: null, warning: null }

  let candidate = cleaned
  if (platform === 'instagram') {
    const m = cleaned.match(/instagram\.com\/([^/?#\s]+)/i)
    if (m) {
      const seg = decodeSafe(m[1])
      if (IG_NON_PROFILE.has(seg.toLowerCase())) {
        return { handle: null, warning: `"${truncate(cleaned)}" is een post/story-link, geen profiel` }
      }
      candidate = seg
    } else if (/tiktok\.com/i.test(cleaned)) {
      return { handle: null, warning: `TikTok-link in de Instagram-kolom: "${truncate(cleaned)}"` }
    }
  } else {
    const m = cleaned.match(/tiktok\.com\/@([^/?#\s]+)/i)
    if (m) {
      candidate = decodeSafe(m[1])
    } else if (/tiktok\.com/i.test(cleaned)) {
      return { handle: null, warning: `TikTok-link zonder @handle: "${truncate(cleaned)}"` }
    } else if (/instagram\.com/i.test(cleaned)) {
      return { handle: null, warning: `Instagram-link in de TikTok-kolom: "${truncate(cleaned)}"` }
    }
  }

  const handle = candidate.replace(/^@/, '').replace(/\/+$/, '').toLowerCase()
  if (!HANDLE_RE.test(handle)) {
    return { handle: null, warning: `geen geldige ${platform}-handle: "${truncate(cleaned)}"` }
  }
  return { handle, warning: null }
}

export function parseCreatorList(text: string): ParsedImport {
  const rows: ImportRow[] = []
  const creatorIds: string[] = []
  const names: Record<string, string> = {}
  const warnings: string[] = []
  const seen = new Set<string>()

  const lines = text.split(/\r?\n/)
  let sawContent = false

  const HEADER_CELL = /^(gasten|naam|name|creator|tag\s+instagram|tag\s+tiktok|instagram|tiktok|ig|tt|handle|url|link)$/i

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim()) continue

    const delim = line.includes('\t') ? '\t' : line.includes(';') ? ';' : ','
    const cells = line.split(delim).map((c) => c.trim())

    // Header heuristic: the first content line whose every cell is a column
    // LABEL ("Gasten", "Tag Instagram") rather than data. Cell-exact on
    // purpose — a handle merely containing "tiktok" must not look like one.
    if (!sawContent && cells.some((c) => c !== '') && cells.every((c) => c === '' || HEADER_CELL.test(c))) {
      sawContent = true
      continue
    }
    sawContent = true
    if (cells.length < 2) {
      warnings.push(`regel ${i + 1} overgeslagen — geen kolommen gevonden: "${truncate(line)}"`)
      continue
    }

    const name = cells[0] ? cells[0].slice(0, 120) : null
    const ig = extractHandle(cells[1] ?? '', 'instagram')
    const tt = extractHandle(cells[2] ?? '', 'tiktok')

    const row: ImportRow = {
      line: i + 1,
      name,
      instagram: ig.handle,
      tiktok: tt.handle,
      rawInstagram: cells[1] ?? '',
      rawTiktok: cells[2] ?? '',
      creatorIds: [],
      warnings: [ig.warning, tt.warning].filter((w): w is string => w != null),
    }

    for (const [platform, handle] of [['instagram', ig.handle], ['tiktok', tt.handle]] as const) {
      if (!handle) continue
      const cid = `${platform}_${handle}`
      if (seen.has(cid)) {
        warnings.push(`dubbele handle overgeslagen op regel ${i + 1}: ${cid}`)
        continue
      }
      seen.add(cid)
      row.creatorIds.push(cid)
      creatorIds.push(cid)
      if (name) names[cid] = name
    }

    if (row.creatorIds.length === 0 && row.warnings.length === 0) {
      row.warnings.push('geen handles op deze regel')
    }
    rows.push(row)
  }

  return { rows, creatorIds, names, warnings }
}

// ── Editable-table support ──────────────────────────────────────────────
//
// After the paste is parsed, the preview table is the editor: each cell can
// be corrected by hand (the client's sheet had at least one barely-legible
// handle). The table's state is plain rows of strings; this turns them into
// the same {creatorIds, names} contract the parser produces, re-validating
// every cell through extractHandle so a manual edit gets exactly the same
// scrutiny as a pasted one.

export type EditableRow = {
  name: string
  instagram: string
  tiktok: string
  included: boolean
}

export function buildSelection(rows: EditableRow[]): {
  creatorIds: string[]
  names: Record<string, string>
  warnings: string[]
} {
  const creatorIds: string[] = []
  const names: Record<string, string> = {}
  const warnings: string[] = []
  const seen = new Set<string>()

  rows.forEach((row, i) => {
    if (!row.included) return
    for (const [platform, raw] of [['instagram', row.instagram], ['tiktok', row.tiktok]] as const) {
      const { handle, warning } = extractHandle(raw, platform)
      if (warning) {
        warnings.push(`rij ${i + 1}: ${warning}`)
        continue
      }
      if (!handle) continue
      const cid = `${platform}_${handle}`
      if (seen.has(cid)) {
        warnings.push(`rij ${i + 1}: dubbele handle overgeslagen (${cid})`)
        continue
      }
      seen.add(cid)
      creatorIds.push(cid)
      const name = row.name.trim()
      if (name) names[cid] = name.slice(0, 120)
    }
  })

  return { creatorIds, names, warnings }
}

/** Parsed rows → editable rows. A cell that failed to parse keeps its RAW
 * pasted value so the user sees what to fix; a cell marked absent ("Geen")
 * becomes empty. */
export function toEditableRows(parsed: ParsedImport): EditableRow[] {
  return parsed.rows.map((r) => ({
    name: r.name ?? '',
    instagram: r.instagram ?? (hasWarningFor(r.rawInstagram, 'instagram') ? r.rawInstagram : ''),
    tiktok: r.tiktok ?? (hasWarningFor(r.rawTiktok, 'tiktok') ? r.rawTiktok : ''),
    included: true,
  }))
}

function hasWarningFor(raw: string, platform: 'instagram' | 'tiktok'): boolean {
  return extractHandle(raw, platform).warning != null
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

function truncate(s: string, n = 60): string {
  return s.length > n ? `${s.slice(0, n)}…` : s
}
