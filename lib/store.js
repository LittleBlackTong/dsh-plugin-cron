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
      this.jobs = raw.filter(j => j && typeof j.id === 'string')
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

  list() {
    return [...this.jobs]
  }

  get(id) {
    return this.jobs.find(j => j.id === id)
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
    }
    this.jobs.push(job)
    this.persist()
    return { ...job }
  }

  update(id, patch) {
    const index = this.jobs.findIndex(j => j.id === id)
    if (index === -1) throw new Error(`job not found: ${id}`)
    const current = this.jobs[index]
    const merged = { ...current, ...patch }
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

  watch(callback) {
    this.watchers.add(callback)
    return () => this.watchers.delete(callback)
  }
}
