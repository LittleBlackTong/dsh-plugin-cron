import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
// Importing lib/index.js here IS the regression test for zero bare runtime
// imports: this suite runs with no node_modules present, so a bare external
// import (e.g. @deepseek-ai/schemastery) would fail the whole file — exactly
// the "failed to import" a link-installed plugin hits on the desktop runtime.
import { Config, apply } from '../lib/index.js'

describe('Config schema (inlined StandardSchemaV1)', () => {
  const validate = (value) => Config['~standard'].validate(value)

  it('resolves an absent config row (undefined) to an empty object', async () => {
    assert.deepStrictEqual(await validate(undefined), { value: {} })
    assert.deepStrictEqual(await validate(null), { value: {} })
  })

  it('keeps declared string fields and drops unknown keys', async () => {
    const result = await validate({ configFile: 'D:/x/jobs.json', cwd: 'D:/ws', extra: 1 })
    assert.deepStrictEqual(result, { value: { configFile: 'D:/x/jobs.json', cwd: 'D:/ws' } })
  })

  it('reports issues for non-string values of declared fields', async () => {
    const result = await validate({ configFile: 123 })
    assert.ok(result.issues?.length >= 1, 'non-string configFile must produce issues')
    assert.match(result.issues[0].message, /configFile/)
  })

  it('rejects non-object config with an issue', async () => {
    const result = await validate('nope')
    assert.ok(result.issues?.length >= 1, 'scalar config must produce issues')
  })

  it('the module graph imports with zero bare runtime imports', () => {
    assert.strictEqual(typeof apply, 'function', 'lib/index.js must import standalone')
    assert.strictEqual(apply.name, 'cron', 'default export must carry the plugin name')
    assert.strictEqual(typeof Config['~standard'].validate, 'function')
  })
})
