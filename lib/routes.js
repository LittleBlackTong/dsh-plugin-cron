/**
 * HTTP API for cron job CRUD + SSE push + session list + manual trigger.
 *
 * @module dsh-plugin-cron/routes
 */

const API_PREFIX = '/api/cron'

function sendJSON(res, status, data) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
  })
  res.end(JSON.stringify(data))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch (e) { reject(new Error('body must be JSON')) }
    })
    req.on('error', reject)
  })
}

/**
 * List live sessions as { id, label } for the fixed-session dropdown.
 * Label prefers the session title (sessionTitle service); falls back to
 * id prefix + creation time so users can still recognize it.
 */
function listSessionChoices(ctx) {
  const sessionsSvc = ctx.get('sessions')
  const titleSvc = ctx.get('sessionTitle')
  const sessions = sessionsSvc ? sessionsSvc.list() : []
  const out = []
  for (const s of sessions) {
    let label = ''
    try {
      if (titleSvc) {
        const snap = titleSvc.get(s)
        if (snap && snap.title) label = snap.title
      }
    } catch { /* title lookup is best-effort */ }
    const id = String(s.id)
    if (!label) {
      const created = s.header && s.header.createdAt ? new Date(s.header.createdAt).toLocaleString('zh-CN') : ''
      label = id.slice(0, 8) + (created ? ` (${created})` : '')
    }
    out.push({ id, label })
  }
  return out
}

/**
 * Single source of truth for the registered HTTP routes.
 *
 * NOTE: the prefix route must NOT end with a trailing slash — the DSH
 * webServer prefix matcher requires `pathname.startsWith(prefix + '/')`,
 * so a trailing slash would demand a double slash in the pathname and
 * PUT/DELETE on /api/cron/jobs/:id would never match.
 */
function buildRouteSpecs(store, sseClients, deps) {
  return [
    // Jobs list + create (exact table wins for the bare path)
    {
      kind: 'exact',
      path: `${API_PREFIX}/jobs`,
      handler: async (req, res) => {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, { 'access-control-allow-methods': 'GET,POST,PUT,DELETE', 'access-control-allow-origin': '*' })
          res.end()
          return
        }
        if (req.method === 'GET') {
          sendJSON(res, 200, { jobs: store.list() })
          return
        }
        if (req.method === 'POST') {
          try {
            const body = await readBody(req)
            const job = store.create(body)
            sendJSON(res, 201, { job })
          } catch (e) {
            sendJSON(res, 400, { error: e.message })
          }
          return
        }
        sendJSON(res, 405, { error: 'method not allowed' })
      },
    },
    // Single job update/delete (prefix, no trailing slash)
    {
      kind: 'prefix',
      path: `${API_PREFIX}/jobs`,
      handler: async (req, res) => {
        if (req.method === 'OPTIONS') {
          res.writeHead(204, { 'access-control-allow-methods': 'PUT,DELETE,POST', 'access-control-allow-origin': '*' })
          res.end()
          return
        }
        const id = req.url.replace(`${API_PREFIX}/jobs/`, '').split('?')[0]
        if (!id) { sendJSON(res, 400, { error: 'missing job id' }); return }
        if (req.method === 'PUT') {
          try {
            const body = await readBody(req)
            const job = store.update(id, body)
            sendJSON(res, 200, { job })
          } catch (e) {
            sendJSON(res, e.message.includes('not found') ? 404 : 400, { error: e.message })
          }
          return
        }
        if (req.method === 'DELETE') {
          const ok = store.delete(id)
          sendJSON(res, ok ? 200 : 404, ok ? { deleted: true } : { error: 'not found' })
          return
        }
        // POST /api/cron/jobs/:id/run — manual trigger
        if (req.method === 'POST' && id.endsWith('/run')) {
          const jobId = id.slice(0, -'/run'.length)
          const triggered = deps.scheduler ? deps.scheduler.runNow(jobId) : false
          if (!triggered) sendJSON(res, 404, { error: 'job not found' })
          else sendJSON(res, 200, { triggered: true })
          return
        }
        sendJSON(res, 405, { error: 'method not allowed' })
      },
    },
    // Session list (for the fixed-session dropdown)
    {
      kind: 'exact',
      path: `${API_PREFIX}/sessions`,
      handler: (req, res) => {
        if (req.method === 'GET') {
          sendJSON(res, 200, { sessions: deps.listSessionChoices ? deps.listSessionChoices() : [] })
          return
        }
        sendJSON(res, 405, { error: 'method not allowed' })
      },
    },
    // SSE endpoint
    {
      kind: 'exact',
      path: `${API_PREFIX}/events`,
      handler: (req, res) => {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'connection': 'keep-alive',
          'access-control-allow-origin': '*',
        })
        res.write('\n')
        sseClients.add(res)
        req.on('close', () => sseClients.delete(res))
      },
    },
  ]
}

/** Route table (kind + path) used by tests to verify matching behavior. */
export function getRouteTable() {
  return buildRouteSpecs().map(({ kind, path }) => ({ kind, path }))
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {import('./store.js').CronJobStore} store
 * @param {{ scheduler?: import('./scheduler.js').CronScheduler }} [deps]
 */
export function registerRoutes(ctx, store, deps = {}) {
  const disposers = []
  const sseClients = new Set()
  const listSessionChoicesBound = () => listSessionChoices(ctx)

  // Notify SSE clients on store changes
  const unwatch = store.watch((jobs) => {
    const data = JSON.stringify({ jobs })
    for (const res of sseClients) {
      try { res.write(`event: jobs-changed\ndata: ${data}\n\n`) } catch { sseClients.delete(res) }
    }
  })
  disposers.push(unwatch)

  const routeDeps = {
    scheduler: deps.scheduler,
    listSessionChoices: listSessionChoicesBound,
  }

  for (const spec of buildRouteSpecs(store, sseClients, routeDeps)) {
    disposers.push(ctx.webServer.register({
      kind: spec.kind,
      path: spec.path,
      handler: spec.handler,
    }))
  }

  return () => {
    for (const d of disposers) { try { d() } catch { /* best-effort */ } }
    for (const res of sseClients) { try { res.end() } catch { /* best-effort */ } }
    sseClients.clear()
  }
}
