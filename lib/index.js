/**
 * dsh-plugin-cron-scheduler — scheduled agent tasks for DeepSeek Harness.
 *
 * Host-plane Cordis plugin that manages persistent cron jobs. Each job
 * injects a user message into a target session on schedule, triggering
 * a full agent turn. Dual-channel: cron_manage Tool (conversational) +
 * settings.section UI (visual management).
 *
 * @module dsh-plugin-cron-scheduler
 */

import { CronJobStore } from './store.js'
import { CronScheduler } from './scheduler.js'
import { registerRoutes } from './routes.js'
import { registerTool } from './tool.js'

export const name = 'cron'

/** Services required before the plugin can start observing agents. */
export const inject = ['sessions', 'agents', 'tools', 'timer']

/** String fields of the plugin config, each optional. */
const CONFIG_STRING_FIELDS = ['configFile', 'cwd']

/**
 * Minimal StandardSchemaV1 schema for the plugin config, inlined instead of
 * built with @deepseek-ai/schemastery. A `link:`/`file:`-installed plugin is
 * real-pathed outside the profile by Node, and a bare `@deepseek-ai/schemastery`
 * import from there only resolves when the host runtime's profile resolver
 * serves the peer — the desktop runtime does not, and the entry fails with
 * "failed to import". Keeping zero bare runtime imports makes the package
 * importable under every install flavor. The shape
 * (`~standard.validate(config)` -> `{ value } | { issues }`) is the same
 * contract cordis consumes schemastery through.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-plugin-cron-scheduler',
    validate(config) {
      if (config === undefined || config === null) return { value: {} }
      if (typeof config !== 'object' || Array.isArray(config)) {
        return { issues: [{ message: 'expected an object with optional configFile/cwd string fields' }] }
      }
      const value = {}
      const issues = []
      for (const field of CONFIG_STRING_FIELDS) {
        const item = config[field]
        if (item === undefined) continue
        if (typeof item !== 'string') {
          issues.push({ message: `$.${field} expected string | undefined but got ${typeof item}` })
        } else {
          value[field] = item
        }
      }
      return issues.length > 0 ? { issues } : { value }
    },
  },
}

/**
 * Cordis plugin entry.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ configFile?: string, cwd?: string }} config
 * @returns {() => void} disposer
 */
export function apply(ctx, config = {}) {
  const store = new CronJobStore({
    path: typeof config.configFile === 'string' && config.configFile.length > 0
      ? config.configFile
      : undefined,
  })

  // Scheduler (needed by both the Tool's run action and the HTTP routes).
  // `cwd` is what a fresh cron session runs in; without it create() leaves the
  // session with no workspace ("_no-cwd"), which tools then have to cope with.
  const scheduler = new CronScheduler({ store, ctx, cwd: config.cwd })

  // Register cron_manage Tool
  const disposeTool = registerTool(ctx, store, scheduler)

  // HTTP routes (optional: headless deployments may lack webServer)
  ctx.inject(['webServer'], (webCtx) => {
    const disposeRoutes = registerRoutes(webCtx, store, { scheduler })
    webCtx.effect(() => disposeRoutes, 'cron.routes()')
    ctx.logger?.info('cron: HTTP API at /api/cron/')
  })

  return ctx.effect(() => {
    scheduler.start()
    ctx.logger?.info?.(`cron: scheduler started, ${store.list().filter(j => j.enabled).length} active job(s)`)
    return () => {
      scheduler.stop()
      disposeTool()
    }
  }, 'cron.lifecycle()')
}

// DSH's loader unwraps a package's default export before it starts the
// Cordis plugin. Keep the default export callable for direct consumers, but
// attach the Cordis metadata to that function so injected services and the
// config schema survive the unwrap step.
Object.defineProperties(apply, {
  name: { value: name },
  inject: { value: inject },
  Config: { value: Config },
})

export default apply
export { CronJobStore } from './store.js'
export { CronScheduler } from './scheduler.js'
