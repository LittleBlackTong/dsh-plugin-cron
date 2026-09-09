# dsh-plugin-cron

> A cron job manager for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): schedule full agent turns on cron expressions — created from natural language conversation or a settings UI.

DeepSeek Harness 的「定时任务」插件：把一条 cron 表达式 + 一段 prompt 存成持久化任务，到点自动向目标会话注入 user message，触发 agent 跑一个**完整 turn**（调工具、写文件、拉数据……想干嘛干嘛）。任务可以用对话一句话创建，也可以在设置面板里可视化增删改。

## 功能特性

- **双通道管理**：对话自然语言创建为主（`cron_manage` Tool），设置面板 UI 编辑/微调为辅，两条通道实时互相同步。
- **完整 agent turn**：任务 = 一条 user prompt，到点注入目标会话，agent 全流程执行（`source.kind: 'plugin'`），不绕过 agent 直接跑。
- **混合会话策略（v0.1）**：每个任务可选
  - `new` — 每次触发**新建**会话（适合一次性/幂等任务，互不污染）；
  - `fixed` — 每次都投进**同一个固定会话**（适合有上下文的延续性任务，如「每天在这个会话里汇报」）。固定会话不存在时自动创建并回写 `fixedSessionId`。
- **零依赖 cron 解析**：自实现 5 字段解析器，无第三方库；支持单值、范围、步进、列表、通配符。
- **SSE 实时同步**：UI 通过 `/api/cron/events` 的 `jobs-changed` 事件实时刷新，任何通道的改动立即可见。
- **错过跳过（missed-skip）**：DSH 不是常驻服务——进程关闭期间的 tick 一律跳过、不补跑（v0.2.0 预留 `catchUp` 补跑）。
- **并发保护**：同一任务上一次触发还在执行时，新 tick 跳过并记 `skippedAt`，绝不重复执行。

## 安装

```sh
dsh plugin --profile <profile> add dsh-plugin-cron
```

（包内置 `dsh.bundle` manifest，`dsh plugin add` 会把 `cordis.patch.yml` 自动挂进 profile 的 bundles 层。）

或者手动在 profile 的 `cordis.patch.yml` 加一行：

```yaml
- insert:
    - id: dsh-cron
      name: dsh-plugin-cron
```

重启 DSH 后生效。之后在 **设置 → ⏰ 定时任务** 面板里随时增删改任务，保存即热应用（无需重启）。

## 快速开始

创建任务的 cron 表达式必须填 **5 个字段**（分 时 日 月 周）。示例：每天 10:00 执行。

```sh
0 10 * * *
```

### 对话示例（自然语言）

直接跟 agent 说，它会自动解析并调用 `cron_manage` Tool：

- **创建**
  > 每天早上 10 点帮我检查一次今天的日程，整理成清单发我。
  - 解析：`schedule: "0 10 * * *"`、`prompt: "检查今天的日程，整理成清单发我。"`、`sessionStrategy: "new"`
- **查看**
  > 列出我所有的定时任务。
  - 调用 `cron_manage` action=list，返回全部任务。
- **修改**
  > 把「日程检查」改成每天晚上 9 点执行。
  - 解析：`action: "update"` + 新 `schedule: "0 21 * * *"`。
- **暂停 / 恢复**
  > 先暂停「日程检查」这个任务。
  - `action: "toggle"` + `enabled: false`；恢复同理 `enabled: true`。
- **删除**
  > 把「日程检查」删掉吧。
  - `action: "delete"`，二次确认后删除。

### UI 使用

设置 → **⏰ 定时任务**：

- **列表**：每行显示名称、cron 表达式、上次运行时间；开关直接切换启用/暂停。
- **新建/编辑**：表单含名称、cron 表达式、指令（prompt）、会话策略（每次新建 / 固定会话 + 固定会话 ID）。
- **删除**：点击删除弹确认框。
- 任何改动（包括对话通道触发的）都通过 SSE `jobs-changed` 实时刷新到面板。

> 截图占位：v0.1.0 发布后补 UI 截图。

## Cron 表达式参考

5 位标准表达式：`分 时 日 月 周`

```
┌───────────── 分钟 (0-59)
│ ┌───────────── 小时 (0-23)
│ │ ┌───────────── 日 (1-31)
│ │ │ ┌───────────── 月 (1-12)
│ │ │ │ ┌───────────── 周几 (0-7, 0 和 7 都表示周日)
│ │ │ │ │
* * * * *
```

| 语法 | 含义 | 示例 |
|---|---|---|
| `*` | 通配，任意值 | `* * * * *` 每分钟 |
| `1,3,5` | 列表 | `0 9,18 * * *` 每天 9:00 和 18:00 |
| `1-5` | 范围 | `0 9 * * 1-5` 工作日 9:00 |
| `*/5` | 步进 | `*/5 * * * *` 每 5 分钟 |
| 组合 | 范围+步进 | `1-59/2 * * * *` 每 2 分钟（奇数分） |

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `configFile` | `<dshHome>/cron-jobs.json` | 任务存储文件路径（`DSH_HOME` 环境变量优先，否则 `~/.dsh`） |

## HTTP API

所有接口挂 `webServer`（无 `webServer` 的 headless 部署自动跳过）。

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/cron/jobs` | 列出全部任务 `{ jobs: [...] }` |
| `POST` | `/api/cron/jobs` | 创建任务，body 为 job 字段，成功返回 `201 { job }` |
| `PUT` | `/api/cron/jobs/:id` | 更新任务，body 为部分字段 patch，成功返回 `200 { job }` |
| `DELETE` | `/api/cron/jobs/:id` | 删除任务，成功 `200 { deleted: true }`，不存在 `404` |
| `GET` | `/api/cron/events` | SSE 推送 `jobs-changed` 事件（store 每次持久化后广播） |

错误统一返回 `{ error: string }`；校验失败 `400`，找不到任务 `404`，方法不支持 `405`。

### 数据模型

```js
{
  id: string,              // UUID v4
  name: string,            // 人类可读名称
  schedule: string,        // 5 位标准 cron 表达式 "0 10 * * *"
  prompt: string,          // 注入给 agent 的完整 user message
  sessionStrategy: 'new' | 'fixed',
  fixedSessionId?: string, // strategy=fixed 时必填
  enabled: boolean,        // 开关
  createdAt: number,       // epoch ms
  lastRunAt?: number,      // 上次触发时间
  nextRunAt?: number,      // 下次预计触发时间
  skippedAt?: number,      // 上次因并发保护被跳过的时间
}
```

存储为 `<dshHome>/cron-jobs.json`（JSON 数组，原子写入：先写 `.tmp` 再 rename）。

## 开发

```sh
node --test 'test/*.test.js'
```

## 已知边界

- 定时器只在 DSH 进程活着时存在（app 关了就停），错过期间不补跑。
- 固定会话策略依赖 `ctx.sessions.get()` 能查到目标会话；查不到时自动新建会话并回写任务。
- 并发保护是「跳过不排队」：上一次执行未结束时，新 tick 记 `skippedAt` 并顺延，不做队列堆积。
- 与 dsh-plugin-memory / dsh-plugin-heartbeat 互相独立、零依赖。

## License

MIT
