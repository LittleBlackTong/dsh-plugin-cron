/**
 * Cron job persistence: atomic JSON file read/write with schema validation.
 *
 * @module dsh-plugin-cron/store
 */

import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { isValidCron } from './cron.js'

export const CRON_JOBS_FILENAME = 'cron-jobs.json'

export function defaultJobsPath() {
  return (process.env.DSH_HOME || `${homedir()}/.dsh`) + '/' + CRON_JOBS_FILENAME
}

function validateFields(fields, isUpdate = false) {
  if (!isUpdate) {
    if (!fields.name || typeof fields.name !== 'string' || fields.name.trim().length === 0) {
      throw new Error('name is required and must be a non-empty string')
    }
    if (!fields.schedule || typeof fields.schedule !== 'string') {
      throw new Error('schedule is required')
    }
    if (!isValidCron(fields.schedule)) {
      throw new Error(`invalid cron expression: "${fields.schedule}"`)
    }
    if (!fields.prompt || typeof fields.prompt !== 'string' || fields.prompt.trim().length === 0) {
      throw new Error('prompt is required and must be a non-empty string')
    }
    if (fields.sessionStrategy !== 'new' && fields.sessionStrategy !== 'fixed') {
      throw new Error('sessionStrategy must be "new" or "fixed"')
    }
    if (fields.sessionStrategy === 'fixed' && (!fields.fixedSessionId || typeof fields.fixedSessionId !== 'string')) {
      throw new Error('fixedSessionId is required when sessionStrategy is "fixed"')
    }
  } else {
    if (fields.schedule !== undefined && !isValidCron(fields.schedule)) {
      throw new Error(`invalid cron expression: "${fields.schedule}"`)
    }
    if (fields.name !== undefined && (typeof fields.name !== 'string' || fields.name.trim().length === 0)) {
      throw new Error('name is required and must be a non-empty string')
    }
    if (fields.prompt !== undefined && (typeof fields.prompt !== 'string' || fields.prompt.trim().length === 0)) {
      throw new Error('prompt is required and must be a non-empty string')
    }
    if (fields.sessionStrategy !== undefined && fields.sessionStrategy !== 'new' && fields.sessionStrategy !== 'fixed') {
      throw new Error('sessionStrategy must be "new" or "fixed"')
    }
    if (fields.sessionStrategy === 'fixed' && !fields.fixedSessionId) {
      throw new Error('fixedSessionId is required when sessionStrategy is "fixed"')
    }
  }
}

export class CronJobStore {
  constructor(options = {}) {
    this.path = options.path ?? defaultJobsPath()
    this.jobs = []
    this.watchers = new Set()
    this.load()
  }

  load() {
    try {
      if (!existsSync(this.path)) return
      const raw = JSON.parse(readFileSync(this.path, 'utf8'))
      if (!Array.isArray(raw)) return
      // Backward-compatible: keep any entry with a string id; run-tracking
      // fields (lastRunStatus/lastRunError/runCount) default below if absent.
      this.jobs = raw
        .filter(j => j && typeof j.id === 'string')
        .map(j => ({
          ...j,
          runCount: typeof j.runCount === 'number' ? j.runCount : 0,
        }))
    } catch {
      // corrupt file: start fresh
      this.jobs = []
    }
  }

  persist() {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, JSON.stringify(this.jobs, null, 2) + '\n')
      renameSync(tmp, this.path)
    } catch (error) {
      throw new Error(`failed to persist cron jobs: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.notify()
  }

  notify() {
    for (const cb of this.watchers) {
      try { cb(this.jobs) } catch { /* best-effort */ }
    }
  }

  /** Copy, not a live reference: callers cannot mutate store internals. */
  list() {
    return this.jobs.map(j => ({ ...j }))
  }

  /** Copy, not a live reference (scheduler reads through this safely). */
  get(id) {
    const job = this.jobs.find(j => j.id === id)
    return job ? { ...job } : undefined
  }

  create(fields) {
    validateFields(fields)
    const job = {
      id: randomUUID(),
      name: fields.name.trim(),
      schedule: fields.schedule.trim(),
      prompt: fields.prompt.trim(),
      sessionStrategy: fields.sessionStrategy,
      fixedSessionId: fields.sessionStrategy === 'fixed' ? fields.fixedSessionId.trim() : undefined,
      enabled: fields.enabled !== false,
      createdAt: Date.now(),
      // run tracking (v0.2)
      lastRunAt: undefined,
      lastRunStatus: undefined, // 'success' | 'failed' | 'skipped'
      lastRunError: undefined,
      runCount: 0,
    }
    this.jobs.push(job)
    this.persist()
    return { ...job }
  }

  update(id, patch) {
    const index = this.jobs.findIndex(j => j.id === id)
    if (index === -1) throw new Error(`job not found: ${id}`)
    const current = this.jobs[index]
    // Immutable fields (id, createdAt) must never be overridden by a patch.
    // Run-tracking fields are written by recordRun(), never by a user patch.
    const { id: _id, createdAt: _createdAt, lastRunAt: _lra, lastRunStatus: _lrs, lastRunError: _lre, runCount: _rc, ...safePatch } = patch
    const merged = { ...current, ...safePatch }
    // Clear fixedSessionId if switching away from fixed
    if (merged.sessionStrategy === 'new') merged.fixedSessionId = undefined
    validateFields(merged, true)
    this.jobs[index] = merged
    this.persist()
    return { ...merged }
  }

  delete(id) {
    const index = this.jobs.findIndex(j => j.id === id)
    if (index === -1) return false
    this.jobs.splice(index, 1)
    this.persist()
    return true
  }

  /**
   * Record one execution outcome. Owns the run-tracking fields so user
   * patches (via update) can never forge or clear them.
   * @param {string} id
   * @param {{ status: 'success'|'failed'|'skipped', error?: string }} outcome
   */
  recordRun(id, outcome) {
    const index = this.jobs.findIndex(j => j.id === id)
    if (index === -1) return false
    const job = this.jobs[index]
    job.lastRunAt = Date.now()
    job.lastRunStatus = outcome.status
    job.lastRunError = outcome.status === 'failed' ? (outcome.error ?? 'unknown error') : undefined
    if (outcome.status === 'success') job.runCount = (job.runCount ?? 0) + 1
    this.persist()
    return true
  }

  /** Internal mutation for the scheduler: set nextRunAt/skippedAt without a
   *  full persist cycle (volatile timestamps; recomputed on next start). */
  touch(id, fields) {
    const job = this.jobs.find(j => j.id === id)
    if (!job) return false
    Object.assign(job, fields)
    return true
  }

  watch(callback) {
    this.watchers.add(callback)
    return () => this.watchers.delete(callback)
  }
}
