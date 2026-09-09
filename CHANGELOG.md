# Changelog

## 0.1.0 (2026-09-08)

- Initial release
- 5-field cron parser (self-implemented, zero deps)
- JSON file persistence (`<dshHome>/cron-jobs.json`)
- Host scheduler with timer chains, missed-skip, concurrency guard
- `cron_manage` Tool for conversational CRUD
- HTTP API (`/api/cron/jobs`) + SSE push
- Client settings.section UI with list, create/edit modal, toggle, delete confirmation
