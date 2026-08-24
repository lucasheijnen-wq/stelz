import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import fs from 'node:fs'
import path from 'node:path'
import { resolvePreviewMedia } from './preview-paths'

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
    eventIds: new Set<string>(
      fs.existsSync(EVENTS_DIR)
        ? fs.readdirSync(EVENTS_DIR).filter((f) => f.endsWith('.json'))
            .map((f) => path.basename(f, '.json'))
        : [],
    ),
  }

  function send(res: any, file: string, type: string) {
    if (!fs.existsSync(file)) {
      res.statusCode = 404
      return res.end('not found')
    }
    res.setHeader('Content-Type', type)
    res.setHeader('Cache-Control', 'no-store')
    fs.createReadStream(file).pipe(res)
  }

  return {
    name: 'stelz-story-preview',
    apply: 'serve' as const,
    configureServer(server: { middlewares: { use: (fn: (req: any, res: any, next: () => void) => void) => void } }) {
      server.middlewares.use((req, res, next) => {
        const url: string = (req.url || '').split('?')[0]
        const fixture = FIXTURES[url]
        if (fixture) return send(res, fixture, 'application/json')
        if (!url.startsWith('/preview-media/')) return next()

        const hit = resolvePreviewMedia(url, roots)
        if (!hit) {
          res.statusCode = 404
          return res.end('not found')
        }
        return send(res, hit.file, hit.type)
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), storyPreview()],
  server: { port: 5173, host: true },
})
