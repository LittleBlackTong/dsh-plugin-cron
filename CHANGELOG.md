# Changelog

所有记录跟随 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格；版本号与 `package.json` 保持一致。

## [0.2.3] - 2026-09-11

### Fixed

- **新建任务的会话「裸奔」导致第一轮必挂（关键修复）**：`new` 策略新建的会话此前只调用 `agents.create({ sessionId })`，**不带模型选择、不带工作目录**。于是系统提示词里 persona 段引用的 `{{model}}` 取不到值，agent 第一轮直接抛 `prompt variable "{{model}}" has no value for this assembly`，**任务永远跑不起来**（而插件把它记成 success，见下一条）。现在 `create`/`resume` 补上：
  - `meta.cwd` —— 让新会话落在真实工作区（不再 `_no-cwd`）；
  - `agentOptions: { provider, model }` —— 用 `agentDefaultModel` 的默认选择；
  - `setup` —— 装一个模型选择器（等价 `@deepseek-ai/dsh-agent` 的 `installModelSelection`：`system-prompt/assemble` 注入 `{{provider}}`/`{{model}}`，`agent/request` 固定请求上的 provider/model）。会话已有记录时优先用它自己的模型，否则用默认值。
- **成败误报**：投递成功不等于执行成功——此前只要消息进 inbox 就记 `success`，turn 挂了也显示绿色。现在投递后会等这一轮结算（上限 15 分钟），按 `turn/end` 的真实结局记录：turn 报错 → `failed` + 错误摘要；超时未结算 → `failed`。
- 新增配置 `cwd`：新建会话的工作目录（不填则由宿主 cwd 决定）。

### Tests

- 新增 3 条回归：新建会话带上 `cwd`+模型选项并装上 assemble 钩子（`{{model}}` 能解析）、turn 报错记 `failed`、turn 正常记 `success`（**50/50 通过**）。

## [0.2.2] - 2026-09-11

### Fixed

- **`cron_manage` 工具「假报错」修复**：`create` / `list` / `update` / `toggle` 返回的 job 对象此前带着 `fixedSessionId` / `lastRunAt` / `lastRunStatus` / `lastRunError` 等 `undefined` 值字段，触发宿主对工具结果的 lossless-JSON 校验（`value is not lossless JSON`）→ **工具调用报错，但副作用其实已经成功**（任务真的建了/改了）。现在 `create` / `get` / `list` / `update` 返回前统一剥掉 `undefined` 字段；固定会话切回 `new` 时 `fixedSessionId` 直接删键，而不是置 `undefined`。
- 影响面：只要列表里存在任一「未设置可选字段」的任务，`cron_manage list` 就会整体报错——创建任务后整个工具都不可用。

### Tests

- 新增回归测试：job 返回对象不含 `undefined` 值键、JSON round-trip 恒等、会话策略切换删键（**47/47 通过**）。

## [0.2.1] - 2026-09-09

### Fixed

- **启动失败修复**：`inject` 数组补齐 `'timer'`——`scheduler.js` 使用 `ctx.timer` 但此前未声明硬依赖，导致插件加载时 `cannot get property "timer" without inject`、整个 plugin tree 加载失败、DSH 启动失败。
- **UI 主题自适应**：按钮改用语义主题变量（`--dsw-alias-button-primary-fill` 背景 + `--dsw-alias-label-primary-inverted` 反色文字），文字改用 `--dsw-alias-label-primary/secondary`，开关随主题翻转——浅色主题黑字、深色主题浅字，修复「全白看不清」与「蓝色突兀」。
- **「立即运行」按钮**：改用主按钮样式（背景+反色文字），避免绿色底上文字看不清；并从任务行移入编辑弹窗。
- **列表留白**：定时任务列表底部加间距，不再紧贴侧边栏设置。

## [0.2.0] - 2026-09-09

### Added

- **执行历史**：每次触发记录 `lastRunStatus`（success/failed/skipped）、失败错误信息 `lastRunError`、成功计数 `runCount`；侧边栏列表展示「上次: 成功/失败/跳过 + 时间」，失败附错误摘要。
- **手动触发**：`cron_manage` 新增 `run` action，HTTP 新增 `POST /api/cron/jobs/:id/run`，侧边栏每行加「跑」按钮，立即执行一次而不改变排班。
- **会话下拉**：固定会话从手动填 session id 改为下拉选择（`GET /api/cron/sessions` 列出存活会话标题 + id，`sessionTitle` 优先，缺省回退 id 前缀 + 创建时间）。
- **`CronJobStore.get()` 返回拷贝**：调用方无法再改 store 内部对象。
- **`recordRun` / `touch` 方法**：执行结果走专用入口、易失时间戳走 `touch`，用户 patch 无法伪造/清空 run-tracking 字段。

### Changed

- **UI 位置**：从设置面板 `settings.section` 子页移到侧边栏底部 `sidebar.footer.action`（新 id `cron-hotplug`），与 Cordis Plugin 面板并列、不替换它；标题去 emoji 闹钟图标，纯文本「定时任务」。
- **配色**：改用主题真实 token（`--dsw-alias-bg-overlay`/`--dsw-alias-border-l1`/`--dsw-alias-label-*`），去掉不存在的 token 与深色 fallback，浅色/深色主题都正确显示（修复黑底看不清）。
- **任务过多高度**：列表容器锚定到视口可用高度，超出内部滚动，不撑爆侧栏。
- **前端校验**：新建/编辑必填项（名称/Cron/指令/固定会话）空时弹中文提示，不发请求。

### Fixed

- `store.update` 现在同时阻止 patch 覆盖不可变字段（`id`/`createdAt`）与 run-tracking 字段（`lastRunAt`/`lastRunStatus`/`lastRunError`/`runCount`）。

## [0.1.0] - 2026-09-08

### Added

- Initial release
- 5-field cron parser (self-implemented, zero deps, 100-year search window)
- JSON file persistence (`<dshHome>/cron-jobs.json`，原子写)
- Host scheduler：timer 链、missed-skip、并发保护、agent delivery（`ctx.agents.get/resume/create` + `followup`）
- `cron_manage` Tool：create/list/update/delete/toggle
- HTTP API（`/api/cron/jobs`）+ SSE push
- Client 设置面板 UI：列表、新建/编辑弹窗、启停、删除确认
