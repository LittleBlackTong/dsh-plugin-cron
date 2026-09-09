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

  it('rejects invalid sessionStrategy on update', () => {
    const job = store.create({
      name: 'Fixed Job',
      schedule: '0 10 * * *',
      prompt: 'Test',
      sessionStrategy: 'new',
      enabled: true,
    })
    assert.throws(() => store.update(job.id, { sessionStrategy: 'bogus' }), /sessionStrategy/)
  })

  it('rejects empty name on update', () => {
    const job = store.create({
      name: 'Rename Me',
      schedule: '0 10 * * *',
      prompt: 'Test',
      sessionStrategy: 'new',
      enabled: true,
    })
    assert.throws(() => store.update(job.id, { name: '   ' }), /name/i)
  })

  it('rejects empty prompt on update', () => {
    const job = store.create({
      name: 'Prompt Me',
      schedule: '0 10 * * *',
      prompt: 'Original',
      sessionStrategy: 'new',
      enabled: true,
    })
    assert.throws(() => store.update(job.id, { prompt: '' }), /prompt/i)
  })

  it('still accepts valid update fields', () => {
    const job = store.create({
      name: 'Valid',
      schedule: '0 10 * * *',
      prompt: 'Test',
      sessionStrategy: 'new',
      enabled: true,
    })
    const updated = store.update(job.id, { name: 'Renamed', enabled: false })
    assert.strictEqual(updated.name, 'Renamed')
    assert.strictEqual(updated.enabled, false)
  })

  it('never lets a patch override immutable id/createdAt fields', () => {
    const job = store.create({
      name: 'Immutable',
      schedule: '0 10 * * *',
      prompt: 'Test',
      sessionStrategy: 'new',
      enabled: true,
    })
    const originalId = job.id
    const originalCreatedAt = job.createdAt
    const updated = store.update(job.id, { id: 'hacked', createdAt: 0, name: 'Still Updated' })
    assert.strictEqual(updated.id, originalId)
    assert.strictEqual(updated.createdAt, originalCreatedAt)
    assert.strictEqual(updated.name, 'Still Updated') // mutable fields still apply
    // and the store's internal record is untouched too
    assert.strictEqual(store.get(job.id).id, originalId)
    assert.strictEqual(store.get(job.id).createdAt, originalCreatedAt)
    assert.strictEqual(store.list().some(j => j.id === 'hacked'), false)
  })

  it('get() returns a copy, not the live internal object', () => {
    const job = store.create({
      name: 'CopyCheck',
      schedule: '0 10 * * *',
      prompt: 'Test',
      sessionStrategy: 'new',
      enabled: true,
    })
    const got = store.get(job.id)
    got.name = 'Mutated Externally'
    assert.strictEqual(store.get(job.id).name, 'CopyCheck', 'mutating get() result must not affect store internals')
  })

  it('never lets a patch override run-tracking fields (lastRunAt/lastRunStatus/runCount)', () => {
    const job = store.create({
      name: 'RunTrack',
      schedule: '0 10 * * *',
      prompt: 'Test',
      sessionStrategy: 'new',
      enabled: true,
    })
    store.recordRun(job.id, { status: 'success' })
    assert.strictEqual(store.get(job.id).runCount, 1)
    assert.strictEqual(store.get(job.id).lastRunStatus, 'success')
    // a user patch must not forge/clear these
    const updated = store.update(job.id, { lastRunAt: 0, lastRunStatus: 'failed', runCount: 999, name: 'Renamed' })
    assert.strictEqual(updated.name, 'Renamed')
    assert.strictEqual(updated.runCount, 1, 'runCount must be preserved against patch')
    assert.strictEqual(updated.lastRunStatus, 'success', 'lastRunStatus must be preserved against patch')
  })

  it('recordRun tracks success/failed/skipped and increments runCount only on success', () => {
    const job = store.create({
      name: 'RunLog',
      schedule: '0 10 * * *',
      prompt: 'Test',
      sessionStrategy: 'new',
      enabled: true,
    })
    store.recordRun(job.id, { status: 'success' })
    store.recordRun(job.id, { status: 'failed', error: 'boom' })
    store.recordRun(job.id, { status: 'skipped' })
    const final = store.get(job.id)
    assert.strictEqual(final.runCount, 1, 'only success increments runCount')
    assert.strictEqual(final.lastRunStatus, 'skipped', 'last status wins')
    assert.ok(final.lastRunAt > 0)
  })

  it('recordRun stores error on failed but clears it on success', () => {
    const job = store.create({
      name: 'ErrLog',
      schedule: '0 10 * * *',
      prompt: 'Test',
      sessionStrategy: 'new',
      enabled: true,
    })
    store.recordRun(job.id, { status: 'failed', error: 'boom' })
    assert.strictEqual(store.get(job.id).lastRunError, 'boom')
    store.recordRun(job.id, { status: 'success' })
    assert.strictEqual(store.get(job.id).lastRunError, undefined, 'success must clear the error')
  })

  it('touch mutates volatile fields without persisting', () => {
    const job = store.create({
      name: 'Touch',
      schedule: '0 10 * * *',
      prompt: 'Test',
      sessionStrategy: 'new',
      enabled: true,
    })
    assert.strictEqual(store.touch(job.id, { nextRunAt: 12345 }), true)
    assert.strictEqual(store.get(job.id).nextRunAt, 12345)
    // not persisted: a fresh store reload does not have it
    const store2 = new CronJobStore({ path: store.path })
    assert.strictEqual(store2.get(job.id).nextRunAt, undefined, 'touch must not persist')
    assert.strictEqual(store.touch('nonexistent', {}), false)
  })
})
