/**
 * HTTP API for cron job CRUD + SSE push.
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

export function registerRoutes(ctx, store) {
  const disposers = []
  const sseClients = new Set()

  // Notify SSE clients on store changes
  const unwatch = store.watch((jobs) => {
    const data = JSON.stringify({ jobs })
    for (const res of sseClients) {
      try { res.write(`event: jobs-changed\ndata: ${data}\n\n`) } catch { sseClients.delete(res) }
    }
  })
  disposers.push(unwatch)

  // Jobs list
  disposers.push(ctx.webServer.register({
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
  }))

  // Single job update/delete
  disposers.push(ctx.webServer.register({
    kind: 'prefix',
    path: `${API_PREFIX}/jobs/`,
    handler: async (req, res) => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-methods': 'PUT,DELETE', 'access-control-allow-origin': '*' })
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
      sendJSON(res, 405, { error: 'method not allowed' })
    },
  }))

  // SSE endpoint
  disposers.push(ctx.webServer.register({
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
  }))

  return () => {
    for (const d of disposers) { try { d() } catch { /* best-effort */ } }
    for (const res of sseClients) { try { res.end() } catch { /* best-effort */ } }
    sseClients.clear()
  }
}
