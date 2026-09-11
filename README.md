# dsh-plugin-cron-scheduler

> A cron scheduler plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): schedule agent tasks on a cron expression — via natural language or a sidebar UI — and each job injects a user message into a target session at the right time, triggering a full agent turn.

DeepSeek Harness 的「定时任务」插件：按 cron 表达式给 agent 排班——到点往目标会话注入一条 user 消息，触发完整一轮 agent 执行（调工具、写文件、拉数据、生成报告，什么都行）。创建方式双通道：对话里自然语言说一句，或侧边栏底部「定时任务」列表里点「新建」。

## 怎么工作

- **Host 平面**：持久化 JSON store（`<dshHome>/cron-jobs.json`，原子写）+ 每任务一条 `ctx.timer` 定时链 + 到点 `agent.followup()` 注入合成 user 消息（`source.kind === 'plugin'`）。
- **会话策略**：
  - `new`（默认）：每次触发开一个新会话，干净隔离；
  - `fixed`：绑定指定会话，累积上下文。绑定会话时是**下拉选择**（列出所有存活会话的标题），不用手填 session id。
- **错过不补跑**：DSH 不是常驻服务，进程关闭期间的 tick 直接跳过，重启后从当前时间往后算，绝不开机风暴。
- **并发保护**：同一任务上一次触发还没结束，新 tick 跳过并记 `skippedAt`，不重复执行。
- **执行历史（v0.2.0）**：每次触发记录 `lastRunStatus`（成功/失败/跳过）+ 错误信息 + `runCount`，侧边栏列表里直接看到「上次: 成功 2026-09-09 10:30」，失败还会显示错误摘要。
- **手动触发（v0.2.0）**：列表里「跑」按钮或对话里 `cron_manage run` 立即执行一次，不改变既定排班。
- **双通道创建**：`cron_manage` 工具（对话自然语言）+ 侧边栏 UI（表单），共享同一套 Host CRUD。
- **UI 位置**：注册到侧边栏底部（`sidebar.footer.action`，新 id `cron-hotplug`），与 Cordis Plugin 面板并列，**不覆盖、不替换**它。任务多时列表在容器内滚动，不会撑爆侧栏。

## 安装

```sh
dsh plugin --profile <profile> add dsh-plugin-cron-scheduler
```

（包内置 `dsh.bundle` manifest，`dsh plugin add` 自动挂进 profile 的 bundles 层；dsh-market 里的一键安装同此通道。）

重启 DSH 后生效。之后在侧边栏底部「定时任务」列表里管理任务，保存即生效（无需重启）。

> ⚠️ **不要**再往 profile 的 `cordis.patch.yml` 里手写 `- insert: {id: dsh-cron, ...}`：
> 那会与 bundle manifest 的自动挂载产生两条同名 entry，整个 profile 会以
> `duplicate loader entry id "dsh-cron"` 启动失败。运行期任务数据走
> `<dshHome>/cron-jobs.json`；覆盖 composition 键（如 `configFile`）用**不带 insert 的
> id 覆盖条目。

## 对话用法（自然语言）

> 阿周：每周一 10:30 帮我导出上一周的 ZDP 数据
> 小蓝：（调用 cron_manage 工具）已创建「每周导出ZDP上周数据」，下次执行：下周一 10:30

支持的 `cron_manage` action：`create` / `list` / `update` / `delete` / `toggle` / `run`。

cron 表达式是标准 5 字段（分 时 日 月 周）：

```
* * * * *
│ │ │ │ └─ 周几 (0-7，0 和 7 = 周日)
│ │ │ └─── 月 (1-12)
│ │ └───── 日 (1-31)
│ └─────── 时 (0-23)
└───────── 分 (0-59)
```

支持单值、范围（`1-5`）、步进（`*/5`）、列表（`1,3,5`）、通配（`*`）。例：

| 表达式 | 含义 |
|---|---|
| `0 10 * * *` | 每天 10:00 |
| `30 10 * * 1` | 每周一 10:30 |
| `*/5 * * * *` | 每 5 分钟 |
| `0 17 * * 5` | 每周五 17:00 |

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `configFile` | `<dshHome>/cron-jobs.json` | 任务数据文件路径（仅 composition 配置） |
| `cwd` | 宿主 cwd | `new` 策略新建会话的工作目录 |

> ⚠️ 新建会话（`new` 策略）必须带模型选择，否则 agent 第一轮会因提示词变量
> `{{model}}` 取不到值而失败。插件会自动从 `agentDefaultModel` 取默认模型并装上
> 对应钩子；`cwd` 决定新会话落在哪个工作区。

> 为什么不用 settings 面板的通用 namespace？DSH 的 settings wire 只服务一张
> 硬编码白名单（`WEB_SETTINGS_NAMESPACES`），插件无法把自有 namespace 暴露给
> 浏览器写入。本插件因此在 host 自建了 `/api/cron/*` 路由，侧边栏 UI 直连该路由。

## HTTP API

| Method | Path | 说明 |
|---|---|---|
| GET | `/api/cron/jobs` | 列出全部任务 |
| POST | `/api/cron/jobs` | 新建任务 |
| PUT | `/api/cron/jobs/:id` | 更新任务 |
| DELETE | `/api/cron/jobs/:id` | 删除任务 |
| POST | `/api/cron/jobs/:id/run` | 立即运行一次 |
| GET | `/api/cron/sessions` | 列出存活会话（固定会话下拉用） |
| GET | `/api/cron/events` | SSE 推送 `jobs-changed` |

## 开发

```sh
node --test 'test/*.test.js'
```

## 已知边界

- 任务只在 DSH 进程活着时存在（app 关了就停，错过不补跑）。
- `nextRunAt` / `skippedAt` 是易失字段（进程内），重启后按当前时间重新计算。
- 固定会话若绑定了一个已不存在的会话，触发时会自动新建并回写 `fixedSessionId`。
- 到点触发需要目标 session 能启动 agent（有 agent 工厂 + 持久化后端）；无可用 agent 时记为「失败」并记录原因，不会崩溃。

## License

MIT
