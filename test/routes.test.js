import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getRouteTable, listSessionChoices } from '../lib/routes.js'

/**
 * Route-match regression test for FINDING C1.
 *
 * The DSH webServer matcher works as follows:
 *   1. Exact table first: a pathname that exactly equals a registered
 *      'exact' route path wins immediately.
 *   2. Otherwise, prefix routes match when
 *      `pathname.startsWith(prefix + '/')`.
 *
 * The prefix route must therefore be registered WITHOUT a trailing slash:
 * with '/api/cron/jobs/', the check becomes
 * `pathname.startsWith('/api/cron/jobs//')` — a double slash that no
 * real pathname contains, so PUT/DELETE on /api/cron/jobs/:id would
 * 404 forever. This test replicates the matcher against the routes the
 * plugin actually registers (via getRouteTable), asserting the FIXED
 * prefix behaves correctly.
 */

function routeTable() {
  const table = getRouteTable()
  assert.ok(Array.isArray(table) && table.length >= 3, 'routes must be registered')
  return table
}

function matchPathname(pathname) {
  const table = routeTable()
  const parsed = pathname.split('?')[0]
  // 1. exact table first
  for (const route of table) {
    if (route.kind === 'exact' && route.path === parsed) {
      return { route, matched: true, kind: 'exact' }
    }
  }
  // 2. prefix table: pathname.startsWith(prefix + '/')
  for (const route of table) {
    if (route.kind === 'prefix' && parsed.startsWith(route.path + '/')) {
      return { route, matched: true, kind: 'prefix' }
    }
  }
  return { matched: false }
}

describe('routes registration (C1 regression)', () => {
  it('prefix route is registered WITHOUT a trailing slash', () => {
    const prefix = routeTable().find(r => r.kind === 'prefix')
    assert.ok(prefix, 'a prefix route must exist')
    assert.strictEqual(prefix.path, '/api/cron/jobs')
    assert.ok(!prefix.path.endsWith('/'), `prefix path must not end with '/': got "${prefix.path}"`)
  })

  it('/api/cron/jobs (bare) matches the exact route', () => {
    const result = matchPathname('/api/cron/jobs')
    assert.strictEqual(result.matched, true)
    assert.strictEqual(result.kind, 'exact')
    assert.strictEqual(result.route.path, '/api/cron/jobs')
  })

  it('/api/cron/jobs/abc123 matches the prefix route', () => {
    const result = matchPathname('/api/cron/jobs/abc123')
    assert.strictEqual(result.matched, true)
    assert.strictEqual(result.kind, 'prefix')
  })

  it('/api/cron/jobs/<uuid>?q=1 matches the prefix route (query stripped)', () => {
    const result = matchPathname('/api/cron/jobs/550e8400-e29b-41d4-a716-446655440000?q=1')
    assert.strictEqual(result.matched, true)
    assert.strictEqual(result.kind, 'prefix')
  })

  it('/api/cron/jobs/ (trailing slash on the collection path) matches the prefix with an empty id', () => {
    // With the fixed prefix '/api/cron/jobs', the trailing-slash collection
    // path passes the prefix check with an EMPTY id segment; the handler's
    // empty-id guard then answers 400 'missing job id' (never a double-slash
    // 404). Assert the matcher resolves it to the prefix route.
    const result = matchPathname('/api/cron/jobs/')
    assert.strictEqual(result.matched, true)
    assert.strictEqual(result.kind, 'prefix')
  })

  it('unrelated paths do not match', () => {
    assert.strictEqual(matchPathname('/api/cron/events').kind, 'exact')
    assert.strictEqual(matchPathname('/api/other').matched, false)
  })

  it('registers the sessions route (for fixed-session dropdown)', () => {
    const table = routeTable()
    assert.ok(table.some(r => r.kind === 'exact' && r.path === '/api/cron/sessions'),
      'must register GET /api/cron/sessions')
  })

  it('/api/cron/jobs/<id>/run (manual trigger) matches the prefix route', () => {
    const result = matchPathname('/api/cron/jobs/550e8400-e29b-41d4-a716-446655440000/run')
    assert.strictEqual(result.matched, true)
    assert.strictEqual(result.kind, 'prefix')
  })
})

describe('listSessionChoices (fixed-session dropdown)', () => {
  // listSessionChoices(ctx, store) merges live sessions with any
  // fixedSessionId already bound by jobs, so a previously-bound session
  // stays selectable even after a restart (persisted but no longer live).

  function makeCtx(liveSessions = []) {
    return {
      get(name) {
        if (name === 'sessions') return { list: () => liveSessions }
        if (name === 'sessionTitle') return { get: () => undefined }
        return undefined
      },
    }
  }
  function makeStore(jobs = []) {
    return { list: () => jobs.map(j => ({ ...j })) }
  }

  it('lists live sessions', () => {
    const ctx = makeCtx([{ id: 'live-1', header: { createdAt: Date.now() } }])
    const choices = listSessionChoices(ctx, makeStore([]))
    assert.deepStrictEqual(choices.map(c => c.id), ['live-1'])
  })

  it('includes a job-bound fixedSessionId even when the session is not live', () => {
    const ctx = makeCtx([]) // no live sessions at all
    const store = makeStore([{ id: 'job-1', sessionStrategy: 'fixed', fixedSessionId: 'bound-42' }])
    const choices = listSessionChoices(ctx, store)
    const ids = choices.map(c => c.id)
    assert.ok(ids.includes('bound-42'), 'bound fixedSessionId must be listed despite not being live')
    assert.match(choices.find(c => c.id === 'bound-42').label, /已绑定/)
  })

  it('de-duplicates a bound session that is also live', () => {
    const ctx = makeCtx([{ id: 'bound-42', header: { createdAt: Date.now() } }])
    const store = makeStore([{ id: 'job-1', sessionStrategy: 'fixed', fixedSessionId: 'bound-42' }])
    const choices = listSessionChoices(ctx, store)
    assert.strictEqual(choices.filter(c => c.id === 'bound-42').length, 1)
  })

  it('ignores jobs that are not fixed strategy', () => {
    const ctx = makeCtx([])
    const store = makeStore([{ id: 'job-1', sessionStrategy: 'new', fixedSessionId: undefined }])
    assert.deepStrictEqual(listSessionChoices(ctx, store), [])
  })
})
