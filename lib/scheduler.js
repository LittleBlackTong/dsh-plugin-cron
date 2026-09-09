/**
 * Cron scheduler: per-job timer chains using ctx.timer.timeout().
 *
 * On each tick: resolves target session id (fixed session if present,
 * else generated), delivers the user message via a live agent found by
 * ctx.agents.get(sessionId) or a resumed/created agent handle
 * (ctx.agents.resume/create), records the run outcome, updates
 * lastRunAt/nextRunAt, re-arms.
 *
 * Missed-fire policy (v0.1): skip, don't catch up.
 * Concurrency guard: skip if previous run for same job still active.
 *
 * @module dsh-plugin-cron/scheduler
 */

import { parseCron, nextMatch } from './cron.js'

/**
 * Resolve a live agent for the target session id, else create/resume one.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} sessionId
 * @param {object} message
 * @returns {Promise<boolean>} true if the message was delivered
 */
async function resolveAgentAndDeliver(ctx, sessionId, message) {
  const live = ctx.agents.get(sessionId)
  if (live) {
    live.followup(message)
    return true
  }
  // No live agent: resume the persisted session if possible; fall back to create.
  try {
    const handle = await ctx.agents.resume({ resumeSessionId: sessionId })
    handle.agent?.followup?.(message)
    return true
  } catch {
    try {
      const handle = await ctx.agents.create({ sessionId })
      handle.agent?.followup?.(message)
      return true
    } catch (err) {
      ctx.logger?.warn?.(`cron: failed to start agent for job: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }
}

export class CronScheduler {
  /**
   * @param {object} options
   * @param {import('./store.js').CronJobStore} options.store
   * @param {import('@deepseek-ai/cordis').Context} options.ctx
   */
  constructor({ store, ctx }) {
    this.store = store
    this.ctx = ctx
    this.timers = new Map() // jobId → disposer
    this.running = new Set() // jobIds currently firing
    this.disposed = false
    this.unwatch = undefined
  }

  start() {
    if (this.disposed) return
    this.scheduleAll()
    this.unwatch = this.store.watch(() => this.reschedule())
  }

  stop() {
    this.disposed = true
    this.unwatch?.()
    this.unwatch = undefined
    for (const dispose of this.timers.values()) {
      try { dispose() } catch { /* best-effort */ }
    }
    this.timers.clear()
  }

  reschedule() {
    if (this.disposed) return
    for (const dispose of this.timers.values()) {
      try { dispose() } catch { /* best-effort */ }
    }
    this.timers.clear()
    this.scheduleAll()
  }

  scheduleAll() {
    const now = new Date()
    for (const job of this.store.list()) {
      if (!job.enabled) continue
      this.armJob(job, now)
    }
  }

  armJob(job, after) {
    if (this.disposed) return
    // Idempotency: dispose any previously armed timer for this job id before
    // arming a new one. A single fire flow can re-arm a job through two
    // paths (store watch → reschedule(), and the finally block below); the
    // last arm wins and only ONE live timer per job is ever kept, so no
    // stale timer escapes the map and stop() can dispose everything.
    const previous = this.timers.get(job.id)
    if (previous) {
      try { previous() } catch { /* best-effort */ }
      this.timers.delete(job.id)
    }
    let schedule
    try {
      schedule = parseCron(job.schedule)
    } catch (err) {
      this.ctx.logger?.warn?.(`cron: invalid schedule for job "${job.id}": ${err.message}`)
      return
    }
    let next
    try {
      next = nextMatch(schedule, after)
    } catch (err) {
      this.ctx.logger?.warn?.(`cron: cannot compute next run for job "${job.id}": ${err.message}`)
      return
    }
    const delayMs = Math.max(0, next.getTime() - Date.now())
    // nextRunAt is volatile (recomputed on every start) — touch, don't persist.
    this.store.touch(job.id, { nextRunAt: next.getTime() })

    const dispose = this.ctx.timer.timeout(() => {
      this.timers.delete(job.id)
      this.fire(job)
    }, delayMs)
    this.timers.set(job.id, dispose)
    this.ctx.logger?.info?.(`cron: armed job "${job.name}" (${job.id}), next in ${Math.round(delayMs / 1000)}s`)
  }

  /**
   * Fire a job immediately (manual trigger). Bypasses the normal schedule;
   * still respects the concurrency guard.
   * @param {string} id
   */
  runNow(id) {
    const job = this.store.get(id)
    if (!job) return false
    this.fire(job)
    return true
  }

  async fire(job) {
    if (this.disposed) return
    // Spec §4.3 ordering: re-read the job and check enabled FIRST, then the
    // concurrency guard. A disabled/deleted job is not re-armed (re-enable
    // triggers reschedule via the store watch).
    const current = this.store.get(job.id)
    if (!current || !current.enabled) {
      this.ctx.logger?.info?.(`cron: job "${job.id}" disabled or deleted before fire`)
      return
    }
    // Concurrency guard
    if (this.running.has(job.id)) {
      this.ctx.logger?.info?.(`cron: skipping job "${current.name}" (${current.id}), previous run still active`)
      this.store.touch(current.id, { skippedAt: Date.now() })
      this.store.recordRun(current.id, { status: 'skipped' })
      this.armJob(current, new Date())
      return
    }
    this.running.add(job.id)
    try {
      // Resolve session id: fixed session if it exists, else a fresh one
      // (create/resume handle session creation through the factory).
      let sessionId
      if (current.sessionStrategy === 'fixed' && current.fixedSessionId) {
        const existing = this.ctx.sessions.get(current.fixedSessionId)
        if (existing) {
          sessionId = existing.id
        } else {
          this.ctx.logger?.warn?.(`cron: fixed session "${current.fixedSessionId}" not found for job "${current.name}", creating new`)
          sessionId = `cron-${current.id}-${Date.now()}`
          this.store.update(current.id, { fixedSessionId: sessionId })
        }
      } else {
        sessionId = `cron-${current.id}-${Date.now()}`
      }
      // Inject user message
      const message = {
        id: `cron-${current.id}-${Date.now()}`,
        role: 'user',
        content: [{ type: 'text', text: current.prompt }],
        source: { kind: 'plugin', plugin: 'cron', jobId: current.id },
      }
      // Deliver through a live/resumed/created agent for the target session
      const delivered = await resolveAgentAndDeliver(this.ctx, sessionId, message)
      this.store.recordRun(current.id, delivered ? { status: 'success' } : { status: 'failed', error: 'message not delivered (no agent available)' })
      this.ctx.logger?.info?.(`cron: fired job "${current.name}" (${current.id}, delivered=${delivered}) into session ${sessionId}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.store.recordRun(job.id, { status: 'failed', error: message })
      this.ctx.logger?.warn?.(`cron: fire failed for job "${job.id}": ${message}`)
    } finally {
      this.running.delete(job.id)
      // Re-arm for next occurrence (armJob is idempotent: disposes any
      // timer the store-watch reschedule may have armed first)
      if (!this.disposed) this.armJob(current, new Date())
    }
  }
}
