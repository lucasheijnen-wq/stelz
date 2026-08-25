// Turning a /preview-media/… URL into a filesystem path, or refusing to.
//
// This lives outside src/ because it is dev-server code and must never enter
// the bundle, and outside vite.config.ts because it is the one piece of that
// file worth testing on its own. It takes a URL a browser sent and produces a
// path on disk: the exact shape that, done carelessly, hands out .env.
//
// THE RULES, AND WHY EACH ONE IS THERE
//
//   basename on every segment      A raw or percent-encoded ../.. must not
//                                  escape. Applied per segment rather than to
//                                  the joined path, so a traversal cannot hide
//                                  in the middle of one.
//   exact Set membership           Not a prefix check, not startsWith. The
//                                  event and the kind are compared against
//                                  fixed sets computed by the server; a segment
//                                  that is not in one never becomes a directory.
//   an extension allow-list        Only the media types the archives hold. A
//                                  request for a .json inside a media directory
//                                  is refused even if the file is there.
//   no fallback                    An unknown event 404s rather than quietly
//                                  serving the default event's stories. Serving
//                                  a different directory than the URL asked for
//                                  is how an allow-list stops being one.

import path from 'node:path'

export const MEDIA_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
}

/** The four archives an event collects. Mirrors _events.KINDS. */
export const ARCHIVE_KINDS = ['stories', 'ig-posts', 'tiktok', 'discovery'] as const

export type PreviewRoots = {
  /** .tmp/events */
  eventsTmp: string
  /** Event ids with a definition on disk. */
  eventIds: Set<string>
  /** The event whose stories fixture the bare /preview-media/<file> form means. */
  defaultEvent: string
}

/**
 * Resolve `/preview-media/<event>/<kind>/<file>` — or the legacy
 * `/preview-media/<file>`, which means the default event's stories.
 *
 * @returns an absolute path and its content type, or null to 404.
 */
export function resolvePreviewMedia(
  url: string,
  roots: PreviewRoots,
): { file: string; type: string } | null {
  if (!url.startsWith('/preview-media/')) return null

  let decoded: string
  try {
    decoded = decodeURIComponent(url)
  } catch {
    // A malformed escape is not a path. Bailing here rather than letting the
    // raw bytes through means %2e%2e cannot arrive half-decoded.
    return null
  }

  const parts = decoded.slice('/preview-media/'.length).split('/').filter(Boolean)
  if (parts.length === 0) return null

  const name = path.basename(parts[parts.length - 1] ?? '')
  const ext = path.extname(name).toLowerCase()
  const type = MEDIA_TYPES[ext]
  if (!type || !name || name.startsWith('.')) return null

  let dir: string
  if (parts.length === 1) {
    dir = path.join(roots.eventsTmp, roots.defaultEvent, 'stories', 'media')
  } else if (parts.length === 3) {
    const ev = path.basename(parts[0])
    const kind = path.basename(parts[1])
    if (!roots.eventIds.has(ev)) return null
    if (!(ARCHIVE_KINDS as readonly string[]).includes(kind)) return null
    dir = path.join(roots.eventsTmp, ev, kind, 'media')
  } else {
    // Two segments, or four. Neither shape exists; guessing which one was meant
    // is how the middle segment ends up unchecked.
    return null
  }

  return { file: path.join(dir, name), type }
}

/**
 * Parse an HTTP Range header against a file size.
 *
 * Videos are why this exists: without 206 support Safari refuses to play a
 * `<video>` at all and Chrome cannot seek. The middleware used to pipe whole
 * files with no `Accept-Ranges`, which made half the archive (the videos)
 * unplayable in the drawer.
 *
 * @returns byte bounds to serve with 206; null to serve the whole file with
 * 200 (no header, malformed header, or a multi-range we choose not to
 * implement); 'unsatisfiable' to answer 416.
 */
export function parseByteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null | 'unsatisfiable' {
  if (!header || size <= 0) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (!m[1] && !m[2])) return null
  if (!m[1]) {
    // Suffix form: the LAST n bytes.
    const n = Number.parseInt(m[2], 10)
    if (n === 0) return 'unsatisfiable'
    return { start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number.parseInt(m[1], 10)
  if (start >= size) return 'unsatisfiable'
  const end = m[2] ? Math.min(Number.parseInt(m[2], 10), size - 1) : size - 1
  if (end < start) return null
  return { start, end }
}
