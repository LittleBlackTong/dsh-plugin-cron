/**
 * Cron scheduler: per-job timer chains using ctx.timer.timeout().
 *
 * On each tick: resolves target session, injects user message via
 * agent.followup(), updates lastRunAt/nextRunAt, re-arms.
 *
 * Missed-fire policy (v0.1): skip, don't catch up.
 * Concurrency guard: skip if previous run for same job still active.
 *
 * @module dsh-plugin-cron/scheduler
 */

import { parseCron, nextMatch } from './cron.js'

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
    // Update nextRunAt in store (without triggering reschedule loop)
    const idx = this.store.jobs.findIndex(j => j.id === job.id)
    if (idx !== -1) this.store.jobs[idx].nextRunAt = next.getTime()

    const dispose = this.ctx.timer.timeout(() => {
      this.timers.delete(job.id)
      this.fire(job)
    }, delayMs)
    this.timers.set(job.id, dispose)
    this.ctx.logger?.info?.(`cron: armed job "${job.name}" (${job.id}), next in ${Math.round(delayMs / 1000)}s`)
  }

  async fire(job) {
    if (this.disposed) return
    // Concurrency guard
    if (this.running.has(job.id)) {
      this.ctx.logger?.info?.(`cron: skipping job "${job.name}" (${job.id}), previous run still active`)
      const idx = this.store.jobs.findIndex(j => j.id === job.id)
      if (idx !== -1) this.store.jobs[idx].skippedAt = Date.now()
      this.armJob(job, new Date())
      return
    }
    this.running.add(job.id)
    try {
      // Re-read job in case it was modified while timer was pending
      const current = this.store.get(job.id)
      if (!current || !current.enabled) {
        this.ctx.logger?.info?.(`cron: job "${job.id}" disabled or deleted before fire`)
        return
      }
      // Resolve session
      let session
      if (current.sessionStrategy === 'fixed' && current.fixedSessionId) {
        session = this.ctx.sessions.get(current.fixedSessionId)
        if (!session) {
          this.ctx.logger?.warn?.(`cron: fixed session "${current.fixedSessionId}" not found for job "${current.name}", creating new`)
          session = this.ctx.sessions.create({ title: `[cron] ${current.name}` })
          this.store.update(current.id, { fixedSessionId: session.id })
        }
      } else {
        session = this.ctx.sessions.create({ title: `[cron] ${current.name}` })
      }
      // Inject user message
      const message = {
        id: `cron-${current.id}-${Date.now()}`,
        role: 'user',
        content: [{ type: 'text', text: current.prompt }],
        source: { kind: 'plugin', plugin: 'cron', jobId: current.id },
      }
      // Find or create agent for session
      let agent = this.ctx.agents.list().find(a => a.session?.id === session.id)
      if (agent) {
        agent.followup(message)
      } else {
        // Session exists but no live agent — resume or create
        try {
          const handle = await this.ctx.agents.resume({ sessionId: session.id })
          handle.agent?.followup?.(message)
        } catch {
          try {
            const handle = await this.ctx.agents.createAgent(this.ctx, { sessionId: session.id })
            handle.agent?.followup?.(message)
          } catch (err) {
            this.ctx.logger?.warn?.(`cron: failed to start agent for job "${current.name}": ${err.message}`)
          }
        }
      }
      // Update lastRunAt
      this.store.update(current.id, { lastRunAt: Date.now() })
      this.ctx.logger?.info?.(`cron: fired job "${current.name}" (${current.id})`)
    } catch (err) {
      this.ctx.logger?.warn?.(`cron: fire failed for job "${job.id}": ${err.message}`)
    } finally {
      this.running.delete(job.id)
      // Re-arm for next occurrence
      if (!this.disposed) this.armJob(job, new Date())
    }
  }
}
