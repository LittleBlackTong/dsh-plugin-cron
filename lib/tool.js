/**
 * cron_manage Tool: structured CRUD for cron jobs, callable by the agent.
 * NL→struct parsing happens in the conversation, not here.
 *
 * @module dsh-plugin-cron-scheduler/tool
 */

import { parseCron, nextMatch } from './cron.js'

export function registerTool(ctx, store, scheduler) {
  return ctx.tools.register({
    name: 'cron_manage',
    description: '管理定时任务：创建(create)、列出(list)、更新(update)、删除(delete)、切换开关(toggle)、立即运行(run)。自然语言由你在对话中解析，本工具只接收结构化参数。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'update', 'delete', 'toggle', 'run'], description: '操作类型' },
        id: { type: 'string', description: '任务ID（update/delete/toggle/run必填）' },
        name: { type: 'string', description: '任务名称' },
        schedule: { type: 'string', description: '5位cron表达式，如 "0 10 * * *"' },
        prompt: { type: 'string', description: '注入给agent的完整指令' },
        sessionStrategy: { type: 'string', enum: ['new', 'fixed'], description: '会话策略' },
        fixedSessionId: { type: 'string', description: '固定会话ID（strategy=fixed时必填）' },
        enabled: { type: 'boolean', description: '是否启用' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          success: { type: 'boolean' },
          job: { type: 'object' },
          jobs: { type: 'array' },
          deleted: { type: 'boolean' },
          triggered: { type: 'boolean' },
          summary: { type: 'string' },
        },
      },
      render(args, value) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
      },
    },
    async execute(args) {
      const { action } = args
      switch (action) {
        case 'create': {
          const job = store.create({
            name: args.name,
            schedule: args.schedule,
            prompt: args.prompt,
            sessionStrategy: args.sessionStrategy || 'new',
            fixedSessionId: args.fixedSessionId,
            enabled: args.enabled !== false,
          })
          let nextRunStr = '未知'
          try {
            const sched = parseCron(job.schedule)
            const next = nextMatch(sched, new Date())
            nextRunStr = next.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
          } catch { /* ignore */ }
          return {
            success: true,
            job,
            summary: `已创建「${job.name}」，下次执行: ${nextRunStr}`,
          }
        }
        case 'list': {
          const jobs = store.list()
          return { jobs }
        }
        case 'update': {
          if (!args.id) throw new Error('id is required for update')
          const patch = {}
          if (args.name !== undefined) patch.name = args.name
          if (args.schedule !== undefined) patch.schedule = args.schedule
          if (args.prompt !== undefined) patch.prompt = args.prompt
          if (args.sessionStrategy !== undefined) patch.sessionStrategy = args.sessionStrategy
          if (args.fixedSessionId !== undefined) patch.fixedSessionId = args.fixedSessionId
          if (args.enabled !== undefined) patch.enabled = args.enabled
          const job = store.update(args.id, patch)
          return {
            success: true,
            job,
            summary: `已更新「${job.name}」`,
          }
        }
        case 'delete': {
          if (!args.id) throw new Error('id is required for delete')
          const ok = store.delete(args.id)
          return { deleted: ok }
        }
        case 'toggle': {
          if (!args.id) throw new Error('id is required for toggle')
          if (args.enabled === undefined) throw new Error('enabled is required for toggle')
          const job = store.update(args.id, { enabled: args.enabled })
          return {
            success: true,
            job,
            summary: `已${args.enabled ? '启用' : '暂停'}「${job.name}」`,
          }
        }
        case 'run': {
          if (!args.id) throw new Error('id is required for run')
          if (!scheduler) throw new Error('scheduler is not available')
          const triggered = scheduler.runNow(args.id)
          return { success: triggered, triggered, summary: triggered ? '已触发立即运行' : '任务不存在或已禁用' }
        }
        default:
          throw new Error(`unknown action: ${action}`)
      }
    },
  })
}
