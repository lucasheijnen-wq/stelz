import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { parseByteRange, resolvePreviewMedia } from './preview-paths'
import {
  authPath, deriveStatus, lockPath, logPath, parseAuthBody, parseLock, parseRunnerUrl,
} from './scrape-runner'

/** Event ids with a definition on disk — the allow-list both dev plugins
 *  validate browser-sent ids against. Computed HERE, never from the URL. */
function eventIdsFrom(dir: string): Set<string> {
  return new Set<string>(
    fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
          .map((f) => path.basename(f, '.json'))
      : [],
  )
}

/**
 * Serves the story preview — the fixtures and the archived media — on the dev
 * server and NOWHERE ELSE.
 *
 * Why a middleware and not files in public/: everything in public/ is copied
 * verbatim into dist/, so `vite build && firebase deploy --only hosting` would
 * publish it. That already happened to the two fixture JSONs — 230 kB of
 * scraped Instagram data, including signed CDN URLs, sitting on public hosting
 * because they had to live somewhere the dev server could reach. Media would
 * have been worse: 118 MB of other people's photographs.
 *
 * `apply: 'serve'` plus `configureServer` means this code path does not exist
 * in a build at all — a stronger guarantee than the DEV checks in
 * lib/devPreview.ts, which depend on the minifier folding them away.
 *
 * Produced by tools/stelz_brand_watch/61_stories_preview_fixture.py and
 * 62_stories_archive.py. Nothing here = 404 = the UI stays on live data.
 */
function storyPreview() {
  const tmp = path.resolve(__dirname, '../../../.tmp')
  const EVENTS_TMP = path.join(tmp, 'events')
  const EVENTS_DIR = path.resolve(__dirname, 'src/data/events')
  // The one event whose stories fixture 61_stories_preview_fixture.py writes.
  const STORIES = path.join(EVENTS_TMP, 'lowlands-2026', 'stories')
  // Where each fixture lives. Explicit map, not a path join on user input:
  // this middleware answers requests from a browser, and "serve whatever the
  // URL names" is how a dev server ends up handing out .env.
  const FIXTURES: Record<string, string> = {
    '/preview-stories.json': path.join(STORIES, 'preview-stories.json'),
    '/preview-story-posts.json': path.join(STORIES, 'preview-story-posts.json'),
    '/preview-campaign.json': path.join(tmp, 'preview-campaign.json'),
    '/preview-campaign-detections.json': path.join(tmp, 'preview-campaign-detections.json'),
    // The audience layer — 76_audience.py, read from raw payloads already on
    // disk. Same serve-only path as the rest: it names real people who
    // commented on public posts and has no business in a build.
    '/preview-audience.json': path.join(tmp, 'preview-audience.json'),
  }
  // Media lives at .tmp/events/<event>/<kind>/media/<file>, so a URL names TWO
  // directories. Resolving that safely is preview-paths.ts, which is a pure
  // function precisely so it can be tested — see preview-paths.test.ts.
  //
  // The event list is read from the definitions directory at startup rather
  // than hard-coded, so adding an event does not mean remembering a second
  // list — but it is still a fixed set computed HERE, not the segment the
  // browser sent.
  const roots = {
    eventsTmp: EVENTS_TMP,
    defaultEvent: 'lowlands-2026',
    eventIds: eventIdsFrom(EVENTS_DIR),
  }

  function send(res: any, file: string, type: string, rangeHeader?: string) {
    if (!fs.existsSync(file)) {
      res.statusCode = 404
      return res.end('not found')
    }
    const size = fs.statSync(file).size
    res.setHeader('Content-Type', type)
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Accept-Ranges', 'bytes')
    const range = parseByteRange(rangeHeader, size)
    if (range === 'unsatisfiable') {
      res.statusCode = 416
      res.setHeader('Content-Range', `bytes */${size}`)
      return res.end()
    }
    if (range) {
      res.statusCode = 206
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`)
      res.setHeader('Content-Length', String(range.end - range.start + 1))
      return fs.createReadStream(file, { start: range.start, end: range.end }).pipe(res)
    }
    // Content-Length also lets the browser NOTICE a truncated body instead of
    // silently parsing half a fixture as "no data".
    res.setHeader('Content-Length', String(size))
    fs.createReadStream(file).pipe(res)
  }

  return {
    name: 'stelz-story-preview',
    apply: 'serve' as const,
    configureServer(server: { middlewares: { use: (fn: (req: any, res: any, next: () => void) => void) => void } }) {
      server.middlewares.use((req, res, next) => {
        const url: string = (req.url || '').split('?')[0]
        const fixture = FIXTURES[url]
        if (fixture) return send(res, fixture, 'application/json', req.headers?.range)
        if (!url.startsWith('/preview-media/')) return next()

        const hit = resolvePreviewMedia(url, roots)
        if (!hit) {
          res.statusCode = 404
          return res.end('not found')
        }
        return send(res, hit.file, hit.type, req.headers?.range)
      })
    },
  }
}

/**
 * The "Opnieuw scrapen" button's backend: two endpoints that exist on the dev
 * server and NOWHERE ELSE (`apply: 'serve'`, same guarantee as storyPreview —
 * this code path is not in a build at all).
 *
 *   POST /scrape-run/<event>     start tools/stelz_brand_watch/79_verversronde.sh
 *                                detached; stdout → .tmp/scrape-<event>.log;
 *                                pid → .tmp/scrape-<event>.lock. 409 while a
 *                                round is already running — two concurrent
 *                                rounds would double-bill Apify/Gemini and
 *                                overwrite each other's fixtures.
 *   GET  /scrape-status/<event>  {running, stale, exitOk, logTail, fixtureMtime}
 *
 * THE BODY OF /scrape-run CARRIES CREDENTIALS. The round's last step uploads
 * the harvest to production, and that endpoint is member-gated. The browser is
 * already signed in as a member, so its refresh token comes along with the
 * click and is parked at authPath() for step 78 to spend — see scrape-runner.ts
 * for why a refresh token and not an ID token. Never echoed, never logged; the
 * response says only whether there were any (`authed`), which is what lets the
 * button warn "deze ronde blijft lokaal" BEFORE an hour of scraping.
 *
 * The event id is validated by exact Set membership before it becomes a shell
 * argument or a file name (see scrape-runner.ts for the rules and the tests).
 */
function scrapeRunner() {
  const ROOT = path.resolve(__dirname, '../../..')
  const TMP = path.join(ROOT, '.tmp')
  const SCRIPT = path.join(ROOT, 'tools', 'stelz_brand_watch', '79_verversronde.sh')
  const eventIds = eventIdsFrom(path.resolve(__dirname, 'src/data/events'))

  const pidAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0)
      return true
    } catch (e) {
      // EPERM means it exists but is not ours — still alive.
      return (e as NodeJS.ErrnoException).code === 'EPERM'
    }
  }
  const readIf = (file: string): string | null =>
    fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
  const json = (res: any, code: number, body: unknown) => {
    res.statusCode = code
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify(body))
  }
  const statusOf = (ev: string) => {
    const pid = parseLock(readIf(lockPath(TMP, ev)))
    const fixture = path.join(TMP, 'preview-campaign.json')
    return deriveStatus({
      lockPid: pid,
      pidAlive: pid != null && pidAlive(pid),
      logText: readIf(logPath(TMP, ev)),
      fixtureMtime: fs.existsSync(fixture) ? fs.statSync(fixture).mtimeMs : null,
    })
  }

  /** The POST body, capped. A refresh token is ~300 bytes; anything claiming to
   *  be more than 8 kB of credentials is not one. */
  const readBody = (req: IncomingMessage): Promise<string> => new Promise((resolve) => {
    let out = ''
    req.on('data', (c: Buffer) => { if (out.length < 8192) out += c.toString('utf8') })
    req.on('end', () => resolve(out.slice(0, 8192)))
    req.on('error', () => resolve(''))
  })

  /** Park the round's upload credentials, if the click brought any. What counts
   *  as a credential is decided by parseAuthBody; this only writes it.
   *  @returns whether this round will be able to reach production. */
  const stashAuth = (ev: string, raw: string): boolean => {
    const creds = parseAuthBody(raw)
    if (!creds) {
      // NO CREDENTIALS MEANS NO CREDENTIALS, so a leftover file from an
      // earlier round must go. It only used to be deleted on a successful
      // upload, so any failure — a 404 preflight, a 401, a dropped connection
      // — left one behind; step 78 runs with --if-authed and no --token-file,
      // finds it, and uploads to production under the PREVIOUS user, while the
      // banner this returns false to says "niet ingelogd, dus deze ronde
      // blijft lokaal". The banner has to be true.
      fs.rmSync(authPath(TMP, ev), { force: true })
      return false
    }
    // 0600: it is a password, and .tmp is a directory people poke around in.
    fs.writeFileSync(authPath(TMP, ev), JSON.stringify(creds), { mode: 0o600 })
    return true
  }

  const startRound = async (ev: string, req: IncomingMessage, res: ServerResponse) => {
    // Body first: an unread request body leaves the socket half-consumed, and
    // the 409 path would then hang the fetch that is only asking to watch.
    const raw = await readBody(req)
    if (statusOf(ev).running) return json(res, 409, { error: 'al bezig' })
    // A stale lock is a crashed previous round; starting anew replaces it.
    fs.mkdirSync(TMP, { recursive: true })
    const authed = stashAuth(ev, raw)
    const fd = fs.openSync(logPath(TMP, ev), 'w')
    const child = spawn('bash', [SCRIPT, ev],
      { cwd: ROOT, detached: true, stdio: ['ignore', fd, fd] })
    child.unref()
    fs.closeSync(fd)
    fs.writeFileSync(lockPath(TMP, ev), String(child.pid))
    return json(res, 200, { started: true, pid: child.pid, authed })
  }

  return {
    name: 'stelz-scrape-runner',
    apply: 'serve' as const,
    configureServer(server: { middlewares: { use: (fn: (req: any, res: any, next: () => void) => void) => void } }) {
      server.middlewares.use((req, res, next) => {
        const url: string = req.url || ''

        const statusEv = parseRunnerUrl(url, '/scrape-status/', eventIds)
        if (statusEv && req.method === 'GET') return json(res, 200, statusOf(statusEv))

        const stopEv = parseRunnerUrl(url, '/scrape-stop/', eventIds)
        if (stopEv && req.method === 'POST') {
          const pid = parseLock(readIf(lockPath(TMP, stopEv)))
          if (pid == null || !pidAlive(pid)) return json(res, 404, { error: 'geen lopende ronde' })
          // detached spawn = its own process group; negative pid stops the
          // whole pipeline (bash + whichever python step is underway).
          try { process.kill(-pid, 'SIGTERM') } catch { try { process.kill(pid, 'SIGTERM') } catch { /* al weg */ } }
          fs.rmSync(lockPath(TMP, stopEv), { force: true })
          // The upload never ran, so its credentials were never spent. A login
          // secret left on disk after the round it belonged to is exactly the
          // kind of thing nobody comes back for.
          fs.rmSync(authPath(TMP, stopEv), { force: true })
          return json(res, 200, { stopped: true })
        }

        const runEv = parseRunnerUrl(url, '/scrape-run/', eventIds)
        if (runEv && req.method === 'POST') {
          void startRound(runEv, req, res)
          return
        }

        return next()
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), storyPreview(), scrapeRunner()],
  server: { port: 5173, host: true },
})
