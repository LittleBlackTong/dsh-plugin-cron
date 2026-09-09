/**
 * Lightweight 5-field cron parser and next-match calculator.
 * Fields: minute hour day-of-month month day-of-week
 * Supports: single values, ranges (1-5), steps (* /5), lists (1,3,5), wildcards (*)
 * Day-of-week: 0 and 7 both mean Sunday.
 *
 * @module dsh-plugin-cron/cron
 */

const FIELD_DEFS = [
  { name: 'minute', min: 0, max: 59, label: 'minute' },
  { name: 'hour', min: 0, max: 23, label: 'hour' },
  { name: 'dom', min: 1, max: 31, label: 'day of month' },
  { name: 'month', min: 1, max: 12, label: 'month' },
  { name: 'dow', min: 0, max: 7, label: 'day-of-week' },
]

function parseField(token, def) {
  if (token === '*') return null // null = wildcard (all values match)
  const values = new Set()
  for (const part of token.split(',')) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/)
    let range, step
    if (stepMatch) {
      range = stepMatch[1]
      step = parseInt(stepMatch[2], 10)
      if (step < 1) throw new Error(`invalid step in ${def.label}: ${part}`)
    } else {
      range = part
      step = 1
    }
    let lo, hi
    if (range === '*') {
      lo = def.min
      hi = def.max
    } else if (range.includes('-')) {
      const [a, b] = range.split('-').map(Number)
      if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error(`invalid range in ${def.label}: ${range}`)
      lo = Math.min(a, b)
      hi = Math.max(a, b)
    } else {
      lo = hi = Number(range)
      if (!Number.isFinite(lo)) throw new Error(`invalid value in ${def.label}: ${range}`)
    }
    const effectiveMax = def.name === 'dow' ? 7 : def.max
    if (lo < def.min || hi > effectiveMax) {
      throw new Error(`${def.label} value out of range [${def.min}-${effectiveMax}]: ${lo}-${hi}`)
    }
    for (let v = lo; v <= hi; v += step) {
      values.add(def.name === 'dow' && v === 7 ? 0 : v)
    }
  }
  if (values.size === 0) throw new Error(`empty field: ${def.label}`)
  return [...values].sort((a, b) => a - b)
}

export function parseCron(expr) {
  const tokens = expr.trim().split(/\s+/)
  if (tokens.length !== 5) throw new Error(`cron expression must have 5 fields, got ${tokens.length}`)
  const result = {}
  for (let i = 0; i < 5; i++) {
    result[FIELD_DEFS[i].name] = parseField(tokens[i], FIELD_DEFS[i])
  }
  return result
}

export function isValidCron(expr) {
  try {
    parseCron(expr)
    return true
  } catch {
    return false
  }
}

function matchesField(value, fieldValues) {
  return fieldValues === null || fieldValues.includes(value)
}

export function nextMatch(schedule, after) {
  // Start from the next whole minute after `after`
  const cursor = new Date(after)
  cursor.setSeconds(0, 0)
  cursor.setMinutes(cursor.getMinutes() + 1)

  // Safety limit: search up to 100 years ahead. Rare constraints (e.g.
  // '0 0 29 2 5' — Feb 29 falling on a Friday) can be decades out; the
  // 400-year Gregorian cycle (~146097 days) guarantees every valid
  // expression matches within this window.
  const limit = new Date(after)
  limit.setFullYear(limit.getFullYear() + 100)

  while (cursor < limit) {
    if (!matchesField(cursor.getMonth() + 1, schedule.month)) {
      // Jump to first day of next matching month
      cursor.setDate(1)
      cursor.setHours(0, 0, 0, 0)
      cursor.setMonth(cursor.getMonth() + 1)
      continue
    }
    if (!matchesField(cursor.getDate(), schedule.dom) || !matchesField(cursor.getDay(), schedule.dow)) {
      cursor.setDate(cursor.getDate() + 1)
      cursor.setHours(0, 0, 0, 0)
      continue
    }
    if (!matchesField(cursor.getHours(), schedule.hour)) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0)
      continue
    }
    if (!matchesField(cursor.getMinutes(), schedule.minute)) {
      cursor.setMinutes(cursor.getMinutes() + 1, 0, 0)
      continue
    }
    return cursor
  }
  throw new Error('no matching time found within 100 years')
}
