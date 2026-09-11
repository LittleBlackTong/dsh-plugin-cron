import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CronScheduler } from '../lib/scheduler.js'

/**
 * Minimal fake context emulating only what CronScheduler touches:
 *  - ctx.timer.timeout(cb, ms) -> disposer (fire the callback when fired)
 *  - ctx.agents.get() -> live agent with followup() (delivery succeeds)
 *  - ctx.sessions.get() -> undefined (so the 'new' strategy generates an id)
 *  - ctx.emit / ctx.logger -> no-ops
 * The store is an in-memory clone of the CronJobStore API (list/get/update)
 * whose update() triggers watchers, so the store-watch -> reschedule() path
 * is exercised exactly as in production.
 */
function makeJob(overrides = {}) {
  return {
    id: 'job-1',
    name: 'Test Job',
    schedule: '*/1 * * * *',
    prompt: 'Do the thing',
    sessionStrategy: 'new',
    fixedSessionId: undefined,
    enabled: true,
    createdAt: Date.now(),
    ...overrides,
  }
}

function makeStore(initialJobs = []) {
  const jobs = initialJobs.map(j => ({ ...j }))
  const watchers = new Set()
  return {
    jobs,
    list() { return jobs.map(j => ({ ...j })) },
    get(id) { return jobs.find(j => j.id === id) },
    update(id, patch) {
      const idx = jobs.findIndex(j => j.id === id)
      if (idx === -1) throw new Error(`job not found: ${id}`)
      jobs[idx] = { ...jobs[idx], ...patch }
      for (const cb of watchers) { try { cb(jobs) } catch { /* best-effort */ } }
      return { ...jobs[idx] }
    },
    // v0.2: volatile in-memory mutation (no persist, no watch) — mirrors store.touch
    touch(id, fields) {
      const idx = jobs.findIndex(j => j.id === id)
      if (idx === -1) return false
      jobs[idx] = { ...jobs[idx], ...fields }
      return true
    },
    // v0.2: run tracking (persist + notify in real store; here notify only)
    recordRun(id, outcome) {
      const idx = jobs.findIndex(j => j.id === id)
      if (idx === -1) return false
      const job = jobs[idx]
      job.lastRunAt = Date.now()
      job.lastRunStatus = outcome.status
      job.lastRunError = outcome.status === 'failed' ? (outcome.error ?? 'unknown error') : undefined
      if (outcome.status === 'success') job.runCount = (job.runCount ?? 0) + 1
      for (const cb of watchers) { try { cb(jobs) } catch { /* best-effort */ } }
      return true
    },
    watch(cb) { watchers.add(cb); return () => watchers.delete(cb) },
  }
}

function makeCtx(store) {
  const ctx = {
    store,
    timer: {
      // Record nothing — the scheduler's own `this.timers` map is the
      // source of truth; each timeout() returns a disposer, as in DSH.
      timeout() {
        return () => { /* dispose */ }
      },
    },
    agents: {
      get() {
        return { followup() {} }
      },
      resume: async () => ({ agent: { followup() {} } }),
      create: async () => ({ agent: { followup() {} } }),
    },
    sessions: { get() { return undefined } },
    emit() {},
    logger: { info() {}, warn() {}, error() {} },
  }
  return ctx
}

describe('CronScheduler timer lifecycle (C2 regression)', () => {
  it('arms exactly ONE live timer per job and re-arm disposes the previous one', async () => {
    const store = makeStore([makeJob()])
    const ctx = makeCtx(store)
    const scheduler = new CronScheduler({ store, ctx })
    scheduler.start()

    // After start: exactly one armed timer for the single enabled job
    assert.strictEqual(scheduler.timers.size, 1, 'start() must arm exactly one timer')

    // Fire the job once. The fire flow:
    //  - store.update({lastRunAt}) -> persist -> notify -> watch -> reschedule()
    //    re-arms the job (timer B)
    //  - the finally block re-arms it again (timer C)
    // With idempotent armJob, the old timer is disposed on each re-arm and
    // the timers map must hold exactly ONE entry afterwards.
    await scheduler.fire(store.get('job-1'))
    assert.strictEqual(scheduler.running.size, 0, 'running set must be cleared after fire')
    assert.strictEqual(scheduler.timers.size, 1, 'fire() must not double-arm: exactly one live timer')

    // stop() must dispose every live timer: the map is the source of truth
    scheduler.stop()
    assert.strictEqual(scheduler.timers.size, 0, 'stop() must dispose all timers')
  })

  it('skip path (concurrency guard) re-arms a single timer and uses fresh job data', async () => {
    const store = makeStore([makeJob()])
    const ctx = makeCtx(store)
    const scheduler = new CronScheduler({ store, ctx })
    scheduler.start()
    assert.strictEqual(scheduler.timers.size, 1)

    // Simulate an active run, then a second fire -> skip path
    scheduler.running.add('job-1')
    await scheduler.fire(store.get('job-1'))
    scheduler.running.delete('job-1')

    // Skip path re-arms once (single timer), and skippedAt was recorded
    assert.strictEqual(scheduler.timers.size, 1, 'skip path must keep exactly one live timer')
    assert.ok(store.get('job-1').skippedAt > 0, 'skip path must record skippedAt')
    scheduler.stop()
    assert.strictEqual(scheduler.timers.size, 0)
  })

  it('does not re-arm a disabled job when it fires', async () => {
    const store = makeStore([makeJob()])
    const ctx = makeCtx(store)
    const scheduler = new CronScheduler({ store, ctx })
    scheduler.start()
    assert.strictEqual(scheduler.timers.size, 1)

    // Disable the job in the store (update triggers watch -> reschedule,
    // which skips disabled jobs entirely)
    store.update('job-1', { enabled: false })
    assert.strictEqual(scheduler.timers.size, 0, 'reschedule must not arm disabled jobs')

    // Even a direct fire on the (stale) job must not re-arm it
    await scheduler.fire(store.get('job-1'))
    assert.strictEqual(scheduler.timers.size, 0, 'firing a disabled job must NOT re-arm')
    scheduler.stop()
  })

  it('runNow triggers a job immediately and records success', async () => {
    const store = makeStore([makeJob()])
    const ctx = makeCtx(store)
    const scheduler = new CronScheduler({ store, ctx })
    scheduler.start()

    assert.strictEqual(scheduler.runNow('job-1'), true)
    // fire is async; wait for the delivery path to settle
    await new Promise((r) => setTimeout(r, 0))
    const job = store.get('job-1')
    assert.strictEqual(job.lastRunStatus, 'success', 'runNow must deliver and record success')
    assert.strictEqual(job.runCount, 1)
    scheduler.stop()
  })

  it('runNow returns false for a missing job', () => {
    const store = makeStore([])
    const ctx = makeCtx(store)
    const scheduler = new CronScheduler({ store, ctx })
    assert.strictEqual(scheduler.runNow('nonexistent'), false)
  })
})

describe('CronScheduler fresh-session setup + real outcome (v0.2.3 regression)', () => {
  /** ctx whose create() actually RUNS the setup hook and exposes its listeners. */
  function makeSetupCtx() {
    const captured = {}
    const ctx = {
      timer: { timeout: () => () => {} },
      agents: {
        get: () => undefined, // no live agent -> resume/create path
        resume: async () => { throw new Error('no persisted session') },
        create: async (options) => {
          const listeners = new Map()
          // A completed turn so the outcome poll settles immediately.
          const agent = {
            followup() {},
            session: { seq: 0, events: [{ seq: 1, type: 'turn/end', data: { reason: { kind: 'completed' } } }] },
          }
          options.setup?.({
            agent,
            on(event, cb) { listeners.set(event, cb); return () => listeners.delete(event) },
          })
          captured.options = options
          captured.listeners = listeners
          captured.agent = agent
          return { agent }
        },
      },
      sessions: { get: () => undefined },
      get: (name) => name === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }) }
        : undefined,
      logger: { info() {}, warn() {}, error() {} },
    }
    return { ctx, captured }
  }

  it('creates a fresh session with cwd + model options and installs the assemble hook', async () => {
    const store = makeStore([makeJob()])
    const { ctx, captured } = makeSetupCtx()
    const scheduler = new CronScheduler({ store, ctx, cwd: '/tmp/ws' })
    await scheduler.fire(store.get('job-1'))

    assert.deepStrictEqual(captured.options.meta, { cwd: '/tmp/ws' }, 'create() must pin the workspace cwd')
    assert.deepStrictEqual(captured.options.agentOptions, { provider: 'deepseek-official', model: 'deepseek-flash' })

    const assemble = captured.listeners.get('system-prompt/assemble')
    assert.strictEqual(typeof assemble, 'function', 'setup must install a model-selection assemble hook')
    const assembled = await assemble({}, {}, async () => ({ variables: {} }))
    assert.strictEqual(assembled.variables.model, 'deepseek-flash', '{{model}} must resolve')
    assert.strictEqual(assembled.variables.provider, 'deepseek-official')
  })

  it('records a failed run when the delivered turn ends in an error', async () => {
    const store = makeStore([makeJob()])
    const ctx = makeCtx(store)
    ctx.agents.get = () => ({
      followup() {},
      session: {
        seq: 0,
        events: [{
          seq: 1,
          type: 'turn/end',
          data: { reason: { kind: 'error', error: { message: 'prompt variable "{{model}}" has no value' } } },
        }],
      },
      whenIdle: async () => {},
    })
    const scheduler = new CronScheduler({ store, ctx })
    await scheduler.fire(store.get('job-1'))

    const job = store.get('job-1')
    assert.strictEqual(job.lastRunStatus, 'failed', 'a failed turn must not be recorded as success')
    assert.match(job.lastRunError, /\{\{model\}\}/)
    assert.strictEqual(job.runCount ?? 0, 0, 'a failed run must not increment runCount')
  })

  it('records success when the delivered turn completes', async () => {
    const store = makeStore([makeJob()])
    const ctx = makeCtx(store)
    ctx.agents.get = () => ({
      followup() {},
      session: { seq: 0, events: [{ seq: 1, type: 'turn/end', data: { reason: { kind: 'completed' } } }] },
      whenIdle: async () => {},
    })
    const scheduler = new CronScheduler({ store, ctx })
    await scheduler.fire(store.get('job-1'))
    assert.strictEqual(store.get('job-1').lastRunStatus, 'success')
  })

  it('setup survives a context whose scoped .agent access throws (inject guard)', async () => {
    const store = makeStore([makeJob()])
    const captured = {}
    const ctx = {
      timer: { timeout: () => () => {} },
      agents: {
        get: () => undefined,
        resume: async () => { throw new Error('no persisted session') },
        create: async (options) => {
          const listeners = new Map()
          const agentCtx = {
            // Cordis throws on a scoped service the context does not inject.
            get agent() { throw new Error('cannot get property "agent" without inject') },
            get: () => undefined,
            on(event, cb) { listeners.set(event, cb); return () => listeners.delete(event) },
          }
          options.setup?.(agentCtx)
          captured.listeners = listeners
          return {
            agent: {
              followup() {},
              session: { seq: 0, events: [{ seq: 1, type: 'turn/end', data: { reason: { kind: 'completed' } } }] },
            },
          }
        },
      },
      sessions: { get: () => undefined },
      get: (name) => name === 'agentDefaultModel'
        ? { currentSelection: () => ({ provider: 'p', model: 'm' }) }
        : undefined,
      logger: { info() {}, warn() {}, error() {} },
    }
    const scheduler = new CronScheduler({ store, ctx })
    await scheduler.fire(store.get('job-1')) // must not throw

    const assemble = captured.listeners.get('system-prompt/assemble')
    assert.strictEqual(typeof assemble, 'function', 'setup must still install the hook')
    const assembled = await assemble({}, {}, async () => ({ variables: {} }))
    assert.strictEqual(assembled.variables.model, 'm', 'fallback selection must still be installed')
    assert.strictEqual(store.get('job-1').lastRunStatus, 'success')
  })

  it('always pins a cwd even when none is configured ({{cwd}} must resolve)', async () => {
    const store = makeStore([makeJob()])
    const { ctx, captured } = makeSetupCtx()
    const scheduler = new CronScheduler({ store, ctx }) // no cwd configured
    await scheduler.fire(store.get('job-1'))
    assert.strictEqual(typeof captured.options.meta?.cwd, 'string', 'create() must always carry meta.cwd')
    assert.ok(captured.options.meta.cwd.length > 0)
  })

  it('waits for a turn/end that lands after the followup (no early green)', async () => {
    const store = makeStore([makeJob()])
    const ctx = makeCtx(store)
    const events = []
    ctx.agents.get = () => ({
      followup() {
        // The turn only settles a beat later, after the first poll.
        setTimeout(() => {
          events.push({ seq: 1, type: 'turn/end', data: { reason: { kind: 'error', error: { message: 'late boom' } } } })
        }, 30)
      },
      session: { seq: 0, events },
    })
    const scheduler = new CronScheduler({ store, ctx })
    await scheduler.fire(store.get('job-1'))
    const job = store.get('job-1')
    assert.strictEqual(job.lastRunStatus, 'failed', 'a late failure must still be recorded')
    assert.match(job.lastRunError, /late boom/)
  })
})
