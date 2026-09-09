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
})
