import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { CronJobStore } from '../lib/store.js'

let dir, store

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cron-test-'))
  store = new CronJobStore({ path: join(dir, 'cron-jobs.json') })
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('CronJobStore', () => {
  it('starts with empty list', () => {
    assert.deepStrictEqual(store.list(), [])
  })

  it('creates a job with generated id and createdAt', () => {
    const job = store.create({
      name: 'Test Job',
      schedule: '0 10 * * *',
      prompt: 'Do something',
      sessionStrategy: 'new',
      enabled: true,
    })
    assert.ok(job.id)
    assert.ok(job.createdAt > 0)
    assert.strictEqual(job.name, 'Test Job')
    assert.strictEqual(job.schedule, '0 10 * * *')
    assert.strictEqual(store.list().length, 1)
  })

  it('persists to disk on create', () => {
    store.create({
      name: 'Persisted',
      schedule: '*/5 * * * *',
      prompt: 'Check status',
      sessionStrategy: 'new',
      enabled: true,
    })
    const raw = JSON.parse(readFileSync(join(dir, 'cron-jobs.json'), 'utf8'))
    assert.strictEqual(raw.length, 1)
    assert.strictEqual(raw[0].name, 'Persisted')
  })

  it('loads existing jobs from disk', () => {
    store.create({
      name: 'Existing',
      schedule: '0 8 * * *',
      prompt: 'Morning task',
      sessionStrategy: 'new',
      enabled: true,
    })
    const store2 = new CronJobStore({ path: join(dir, 'cron-jobs.json') })
    assert.strictEqual(store2.list().length, 1)
    assert.strictEqual(store2.list()[0].name, 'Existing')
  })

  it('updates a job', () => {
    const job = store.create({
      name: 'Original',
      schedule: '0 10 * * *',
      prompt: 'Old prompt',
      sessionStrategy: 'new',
      enabled: true,
    })
    const updated = store.update(job.id, { name: 'Updated', enabled: false })
    assert.strictEqual(updated.name, 'Updated')
    assert.strictEqual(updated.enabled, false)
    assert.strictEqual(updated.prompt, 'Old prompt') // unchanged
  })

  it('deletes a job', () => {
    const job = store.create({
      name: 'ToDelete',
      schedule: '0 10 * * *',
      prompt: 'Bye',
      sessionStrategy: 'new',
      enabled: true,
    })
    assert.strictEqual(store.delete(job.id), true)
    assert.strictEqual(store.list().length, 0)
    assert.strictEqual(store.delete('nonexistent'), false)
  })

  it('validates cron expression on create', () => {
    assert.throws(() => store.create({
      name: 'Bad Cron',
      schedule: '99 * * * *',
      prompt: 'Nope',
      sessionStrategy: 'new',
      enabled: true,
    }), /cron/i)
  })

  it('validates required fields on create', () => {
    assert.throws(() => store.create({
      schedule: '0 10 * * *',
      prompt: 'Missing name',
      sessionStrategy: 'new',
      enabled: true,
    }), /name/i)
  })

  it('requires fixedSessionId when strategy is fixed', () => {
    assert.throws(() => store.create({
      name: 'Fixed No ID',
      schedule: '0 10 * * *',
      prompt: 'Missing session',
      sessionStrategy: 'fixed',
      enabled: true,
    }), /fixedSessionId/i)
  })

  it('notifies watchers on changes', () => {
    let notified = 0
    store.watch(() => { notified++ })
    store.create({
      name: 'Watched',
      schedule: '0 10 * * *',
      prompt: 'Test',
      sessionStrategy: 'new',
      enabled: true,
    })
    assert.strictEqual(notified, 1)
  })
})
