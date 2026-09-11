/**
 * Cron scheduler: per-job timer chains using ctx.timer.timeout().
 *
 * On each tick: resolves target session id (fixed session if present,
 * else generated), delivers the user message via a live agent found by
 * ctx.agents.get(sessionId) or a resumed/created agent handle
 * (ctx.agents.resume/create), records the run outcome, updates
 * lastRunAt/nextRunAt, re-arms.
 *
 * ## Fresh sessions need a model selection
 *
 * A session created outside the Web surface starts with no model at all.
 * Prompt assembly only knows `{{model}}` / `{{provider}}` because an
 * `system-prompt/assemble` listener writes them into the assembled variables,
 * and the request only carries provider/model because an `agent/request`
 * listener writes those (see `@deepseek-ai/dsh-agent`'s `installModelSelection`,
 * which the Web proxy installs for every session it opens). This plugin cannot
 * import that package, so it owns the same two-listener contract locally and
 * installs it through `agents.create`/`resume`'s `setup` hook — otherwise the
 * very first turn dies with `prompt variable "{{model}}" has no value`.
 *
 * Missed-fire policy (v0.1): skip, don't catch up.
 * Concurrency guard: skip if previous run for same job still active.
 *
 * @module dsh-plugin-cron-scheduler/scheduler
 */

import { parseCron, nextMatch } from './cron.js'

/** Cap on how long one fired turn may run before the run is recorded as failed. */
const TURN_TIMEOUT_MS = 15 * 60 * 1000

/**
 * Install a mutable model selection on an Agent's scoped context.
 *
 * Mirrors `installModelSelection` from `@deepseek-ai/dsh-agent` (not importable
 * from a plugin): the assemble listener publishes `provider`/`model` as prompt
 * variables, the request listener pins them on the outgoing request.
 *
 * @param {object} agentCtx the created/resumed Agent's scoped context
 * @param {{ current?: object, assembled?: object }} selection mutable selection
 */
function installModelSelection(agentCtx, selection) {
  agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const selected = selection.current
    const assembled = await next()
    selection.assembled = selected
    if (selected === undefined) return assembled
    return {
      ...assembled,
      variables: { ...assembled.variables, provider: selected.provider, model: selected.model },
    }
  })
  agentCtx.on('agent/request', async (_payload, next) => {
    const resolved = await next()
    const selected = selection.assembled
    if (selected === undefined) return resolved
    const { reasoningEffort: _inherited, ...withoutInheritedEffort } = resolved
    return {
      ...withoutInheritedEffort,
      provider: selected.provider,
      model: selected.model,
      ...selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort },
    }
  })
}

/** The deployment's default model selection, or undefined when unavailable. */
function readDefaultSelection(ctx) {
  try {
    return ctx.get?.('agentDefaultModel')?.currentSelection?.()
  } catch {
    return undefined
  }
}

/** Selection already recorded on the session (a resumed/fixed conversation). */
function loggedSelection(agent) {
  const config = agent?.session?.requestHeader?.()?.config
  if (config === undefined) return undefined
  return {
    provider: config.provider,
    model: config.model,
    ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
  }
}

/**
 * The Agent behind a scoped setup context, without tripping Cordis' inject
 * guard. `agentCtx.agent` throws `cannot get property "agent" without inject`
 * when the context does not declare `inject: ['agent']` — and a plugin cannot
 * retrofit the inject list onto the Agent's own scope — so ask dynamically and
 * treat a miss as "no logged selection" instead of failing the whole run.
 * @param {object} agentCtx
 * @returns {object|undefined}
 */
function readScopedAgent(agentCtx) {
  try {
    return agentCtx.get?.('agent')
  } catch {
    return undefined
  }
}

/**
 * Build the `setup` hook for create/resume: install a model selection that
 * prefers the session's own logged model and otherwise uses the deployment
 * default. Returns undefined (no setup) when neither is available, so the
 * previous behaviour is preserved on a deployment that exposes no default.
 * @param {object|undefined} fallback deployment default selection
 */
function makeSelectionSetup(fallback) {
  return (agentCtx) => {
    const current = loggedSelection(readScopedAgent(agentCtx)) ?? fallback
    if (current === undefined) return undefined
    installModelSelection(agentCtx, { current, assembled: undefined })
    return undefined
  }
}

/**
 * Resolve a live agent for the target session id, else resume/create one with
 * the model selection and workspace metadata a fresh session needs.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} sessionId
 * @param {object} message
 * @param {{ cwd?: string, selection?: object }} options
 * @returns {Promise<{ ok: boolean, agent?: object, firstSeq?: number, error?: string }>}
 */
async function resolveAgentAndDeliver(ctx, sessionId, message, options = {}) {
  const { cwd, selection } = options
  const setup = makeSelectionSetup(selection)
  const agentOptions = selection === undefined
    ? undefined
    : { provider: selection.provider, model: selection.model }
  if (selection === undefined) {
    // Without a selection a fresh session has no {{model}} and its first turn
    // dies in prompt assembly — say so loudly instead of failing silently.
    ctx.logger?.warn?.('cron: no model selection available (agentDefaultModel missing?); a fresh session may fail to assemble its prompt')
  }

  const live = ctx.agents.get(sessionId)
  if (live) {
    const firstSeq = live.session?.seq ?? 0
    live.followup(message)
    return { ok: true, agent: live, firstSeq }
  }

  // Prefer resuming a persisted session; otherwise create a fresh one with the
  // metadata + model selection that a bare `create({ sessionId })` leaves out.
  try {
    const handle = await ctx.agents.resume({ resumeSessionId: sessionId, agentOptions, setup })
    const agent = handle.agent
    const firstSeq = agent?.session?.seq ?? 0
    agent?.followup?.(message)
    return { ok: true, agent, firstSeq }
  } catch {
    try {
      const handle = await ctx.agents.create({
        sessionId,
        ...cwd === undefined ? {} : { meta: { cwd } },
        ...agentOptions === undefined ? {} : { agentOptions },
        setup,
      })
      const agent = handle.agent
      const firstSeq = agent?.session?.seq ?? 0
      agent?.followup?.(message)
      return { ok: true, agent, firstSeq }
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err)
      ctx.logger?.warn?.(`cron: failed to start agent for job: ${text}`)
      return { ok: false, error: text }
    }
  }
}

/** Wait for the agent to go idle, capped so a hung turn cannot wedge the job. */
function whenIdleCapped(agent, ms) {
  if (typeof agent?.whenIdle !== 'function') return Promise.resolve('unknown')
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve('timeout')
    }, ms)
    timer.unref?.()
    agent.whenIdle().then(
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve('idle')
      },
      () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve('error')
      },
    )
  })
}

/** Last turn's end reason at/after `afterSeq` (mirrors dsh-headless' summarize). */
function lastTurnReason(agent, afterSeq) {
  let reason
  for (const event of agent?.session?.events ?? []) {
    if (event.seq < afterSeq) continue
    if (event.type === 'turn/end') reason = event.data?.reason
  }
  return reason
}

/**
 * Wait for the delivered turn to settle and turn its real outcome into a run
 * error. Delivery alone is not success: the turn can still fail (bad prompt
 * assembly, model error, tool crash) long after the inbox accepted the message.
 * @returns {Promise<{ error?: string }>}
 */
async function settleOutcome(agent, firstSeq) {
  if (agent === undefined) return {}
  const state = await whenIdleCapped(agent, TURN_TIMEOUT_MS)
  const reason = lastTurnReason(agent, firstSeq)
  if (reason?.kind === 'error') {
    return { error: reason.error?.message ?? 'agent turn failed' }
  }
  if (state === 'timeout') {
    return { error: `agent turn did not settle within ${Math.round(TURN_TIMEOUT_MS / 60000)} min` }
  }
  return {}
}

export class CronScheduler {
  /**
   * @param {object} options
   * @param {import('./store.js').CronJobStore} options.store
   * @param {import('@deepseek-ai/cordis').Context} options.ctx
   * @param {string} [options.cwd] workspace a fresh session runs in
   */
  constructor({ store, ctx, cwd }) {
    this.store = store
    this.ctx = ctx
    this.cwd = cwd
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
      // Deliver through a live/resumed/created agent for the target session,
      // then wait for the turn so a failed run is recorded as failed instead
      // of a green "delivered".
      const delivered = await resolveAgentAndDeliver(this.ctx, sessionId, message, {
        cwd: this.cwd,
        selection: readDefaultSelection(this.ctx),
      })
      if (!delivered.ok) {
        this.store.recordRun(current.id, { status: 'failed', error: delivered.error ?? 'message not delivered (no agent available)' })
      } else {
        const outcome = await settleOutcome(delivered.agent, delivered.firstSeq)
        this.store.recordRun(current.id, outcome.error === undefined
          ? { status: 'success' }
          : { status: 'failed', error: outcome.error })
      }
      this.ctx.logger?.info?.(`cron: fired job "${current.name}" (${current.id}, delivered=${delivered.ok}) into session ${sessionId}`)
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
