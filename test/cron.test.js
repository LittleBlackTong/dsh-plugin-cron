import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseCron, nextMatch, isValidCron } from '../lib/cron.js'

describe('parseCron', () => {
  it('parses "0 10 * * *" (every day at 10:00)', () => {
    const schedule = parseCron('0 10 * * *')
    assert.deepStrictEqual(schedule.minute, [0])
    assert.deepStrictEqual(schedule.hour, [10])
    assert.strictEqual(schedule.dom, null) // null = wildcard
    assert.strictEqual(schedule.month, null)
    assert.strictEqual(schedule.dow, null)
  })

  it('parses "*/5 * * * *" (every 5 minutes)', () => {
    const schedule = parseCron('*/5 * * * *')
    assert.ok(schedule.minute.includes(0))
    assert.ok(schedule.minute.includes(5))
    assert.ok(schedule.minute.includes(55))
    assert.strictEqual(schedule.minute.length, 12)
  })

  it('parses "0 17 * * 5" (every Friday at 17:00)', () => {
    const schedule = parseCron('0 17 * * 5')
    assert.deepStrictEqual(schedule.minute, [0])
    assert.deepStrictEqual(schedule.hour, [17])
    assert.deepStrictEqual(schedule.dow, [5])
  })

  it('parses "30 9 1,15 * *" (1st and 15th at 9:30)', () => {
    const schedule = parseCron('30 9 1,15 * *')
    assert.deepStrictEqual(schedule.minute, [30])
    assert.deepStrictEqual(schedule.hour, [9])
    assert.deepStrictEqual(schedule.dom, [1, 15])
  })

  it('parses "0 8-12 * * *" (hourly range 8-12)', () => {
    const schedule = parseCron('0 8-12 * * *')
    assert.deepStrictEqual(schedule.hour, [8, 9, 10, 11, 12])
  })

  it('treats Sunday as both 0 and 7', () => {
    const s0 = parseCron('0 0 * * 0')
    const s7 = parseCron('0 0 * * 7')
    assert.deepStrictEqual(s0.dow, [0])
    assert.deepStrictEqual(s7.dow, [0])
  })

  it('throws on invalid expression', () => {
    assert.throws(() => parseCron('60 * * * *'), /minute/)
    assert.throws(() => parseCron('* 24 * * *'), /hour/)
    assert.throws(() => parseCron('* * 32 * *'), /day/)
    assert.throws(() => parseCron('* * * 13 *'), /month/)
    assert.throws(() => parseCron('* * * * 8'), /day-of-week/)
    assert.throws(() => parseCron('* * *'), /5 fields/)
    assert.throws(() => parseCron('abc * * * *'), /invalid/)
  })
})

describe('isValidCron', () => {
  it('returns true for valid expressions', () => {
    assert.strictEqual(isValidCron('0 10 * * *'), true)
    assert.strictEqual(isValidCron('*/5 0-23 1-31 1-12 0-7'), true)
  })

  it('returns false for invalid expressions', () => {
    assert.strictEqual(isValidCron('60 * * * *'), false)
    assert.strictEqual(isValidCron('* * *'), false)
    assert.strictEqual(isValidCron('abc'), false)
  })
})

describe('nextMatch', () => {
  it('finds next occurrence of "0 10 * * *"', () => {
    const schedule = parseCron('0 10 * * *')
    const after = new Date('2026-09-08T09:00:00')
    const result = nextMatch(schedule, after)
    assert.strictEqual(result.getHours(), 10)
    assert.strictEqual(result.getMinutes(), 0)
    assert.strictEqual(result.getDate(), 8)
  })

  it('rolls to next day when time has passed', () => {
    const schedule = parseCron('0 10 * * *')
    const after = new Date('2026-09-08T11:00:00')
    const result = nextMatch(schedule, after)
    assert.strictEqual(result.getDate(), 9)
    assert.strictEqual(result.getHours(), 10)
  })

  it('handles day-of-week constraint', () => {
    const schedule = parseCron('0 17 * * 5') // Friday
    const after = new Date('2026-09-08T00:00:00') // Tuesday
    const result = nextMatch(schedule, after)
    assert.strictEqual(result.getDay(), 5) // Friday
    assert.strictEqual(result.getHours(), 17)
  })

  it('handles month rollover', () => {
    const schedule = parseCron('0 0 1 * *') // 1st of month
    const after = new Date('2026-09-15T00:00:00')
    const result = nextMatch(schedule, after)
    assert.strictEqual(result.getMonth(), 9) // October (0-indexed)
    assert.strictEqual(result.getDate(), 1)
  })
})
