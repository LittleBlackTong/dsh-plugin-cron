# Changelog

所有记录跟随 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 风格；版本号与 `package.json` 保持一致。

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
