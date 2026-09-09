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

import z from '@deepseek-ai/schemastery'
import { CronJobStore } from './store.js'
import { CronScheduler } from './scheduler.js'
import { registerRoutes } from './routes.js'
import { registerTool } from './tool.js'

export const name = 'cron'

/** Services required before the plugin can start observing agents. */
export const inject = ['sessions', 'agents', 'tools', 'timer']

/** Schemastery schema applied to the plugin config before startup. */
export const Config = z.object({
  configFile: z.union([z.string(), z.const(undefined)]),
})

/**
 * Cordis plugin entry.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ configFile?: string }} config
 * @returns {() => void} disposer
 */
export function apply(ctx, config = {}) {
  const store = new CronJobStore({
    path: typeof config.configFile === 'string' && config.configFile.length > 0
      ? config.configFile
      : undefined,
  })

  // Scheduler (needed by both the Tool's run action and the HTTP routes)
  const scheduler = new CronScheduler({ store, ctx })

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
