/**
 * dsh-plugin-cron 客户端半（零构建）：
 * 在设置面板注册「⏰ 定时任务」区块 —— 任务列表 + 新建/编辑/删除 + SSE 实时同步。
 *
 * 数据通道：直连插件自建 HTTP 路由（/api/cron/*）：
 * GET/POST /api/cron/jobs、PUT/DELETE /api/cron/jobs/:id、SSE /api/cron/events。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-cron',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    let react = require('react')

    const React = react
    const JOBS_URL = '/api/cron/jobs'
    const EVENTS_URL = '/api/cron/events'

    // ---- 样式（CSS 变量 + 内联，与 heartbeat 一致） ----
    const rowStyle = {
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: '12px',
      padding: '14px 16px',
      borderBottom: '1px solid var(--dsw-alias-border-l1, rgba(128,128,128,0.2))',
    }
    const labelStyle = { fontSize: '14px', lineHeight: '22px' }
    const subStyle = { fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #999)' }
    const errorStyle = { padding: '0 16px 8px', fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary, #e5484d)' }
    const inputStyle = {
      width: '100%',
      boxSizing: 'border-box',
      padding: '8px 10px',
      fontSize: '14px',
      borderRadius: '6px',
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
      background: 'var(--dsw-alias-bg-layer-1, transparent)',
      color: 'var(--dsw-alias-label-primary, inherit)',
    }
    const buttonPrimary = {
      padding: '6px 14px',
      fontSize: '13px',
      borderRadius: '6px',
      border: 'none',
      cursor: 'pointer',
      background: 'var(--dsw-alias-brand-primary, #4c8bf5)',
      color: '#fff',
    }
    const buttonGhost = {
      padding: '6px 14px',
      fontSize: '13px',
      borderRadius: '6px',
      border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
      cursor: 'pointer',
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary, inherit)',
    }
    const buttonDanger = {
      padding: '6px 14px',
      fontSize: '13px',
      borderRadius: '6px',
      border: 'none',
      cursor: 'pointer',
      background: 'var(--dsw-alias-state-error-primary, #e5484d)',
      color: '#fff',
    }

    // ---- 通用小组件 ----
    function Toggle({ checked, disabled, onChange }) {
      return React.createElement('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked,
        disabled,
        onClick: () => onChange(!checked),
        style: {
          position: 'relative',
          width: '40px',
          height: '22px',
          borderRadius: '11px',
          border: 'none',
          cursor: disabled ? 'not-allowed' : 'pointer',
          background: checked ? 'var(--dsw-alias-brand-primary, #4c8bf5)' : 'var(--dsw-alias-label-secondary, #666)',
          opacity: disabled ? 0.5 : 1,
          transition: 'background 0.15s',
          flexShrink: 0,
        },
      }, React.createElement('span', {
        style: {
          position: 'absolute',
          top: '2px',
          left: checked ? '20px' : '2px',
          width: '18px',
          height: '18px',
          borderRadius: '9px',
          background: '#fff',
          transition: 'left 0.15s',
        },
      }))
    }

    function ErrorText({ message }) {
      return React.createElement('div', { style: { padding: '14px 16px', fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-state-error-primary, #e5484d)' } },
        '加载失败: ', message)
    }

    /** 渲染期兜底：任何异常都以文案形式显示，绝不空白。 */
    class SectionBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: undefined }
      }
      static getDerivedStateFromError(error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
      render() {
        if (this.state.error !== undefined) return React.createElement(ErrorText, { message: this.state.error })
        return this.props.children
      }
    }

    function fieldLabel(text) {
      return React.createElement('label', {
        style: { display: 'block', fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-secondary, #999)', marginBottom: '4px' },
      }, text)
    }

    // ---- 工具 ----
    const readJSON = async (response) => {
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
      return body
    }

    const formatLastRun = (job) => {
      if (!job.lastRunAt) return '从未运行'
      const date = new Date(job.lastRunAt)
      return Number.isNaN(date.getTime()) ? String(job.lastRunAt) : date.toLocaleString()
    }

    // ---- 任务行 ----
    function JobCard({ job, busy, onToggle, onEdit, onDelete }) {
      return React.createElement('div', { style: rowStyle },
        React.createElement(Toggle, {
          checked: job.enabled !== false,
          disabled: busy,
          onChange: (next) => onToggle(job, next),
        }),
        React.createElement('div', { style: { flex: 1, minWidth: 0 } },
          React.createElement('div', { style: labelStyle }, job.name),
          React.createElement('div', { style: subStyle }, `${job.schedule} · 上次: ${formatLastRun(job)}`),
        ),
        React.createElement('div', { style: { display: 'flex', gap: '8px', flexShrink: 0 } },
          React.createElement('button', { type: 'button', onClick: () => onEdit(job), style: buttonGhost }, '编辑'),
          React.createElement('button', { type: 'button', onClick: () => onDelete(job), style: Object.assign({}, buttonGhost, { color: 'var(--dsw-alias-state-error-primary, #e5484d)', borderColor: 'var(--dsw-alias-state-error-primary, #e5484d)' }) }, '删除'),
        ),
      )
    }

    // ---- 弹窗容器 ----
    function Modal({ title, onClose, children, width }) {
      return React.createElement('div', {
        style: {
          position: 'fixed',
          inset: 0,
          zIndex: 1000,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(0,0,0,0.45)',
        },
        onClick: (e) => { if (e.target === e.currentTarget) onClose() },
      },
        React.createElement('div', {
          style: {
            width: width ?? '480px',
            maxWidth: 'calc(100vw - 32px)',
            maxHeight: 'calc(100vh - 64px)',
            overflowY: 'auto',
            boxSizing: 'border-box',
            background: 'var(--dsw-alias-bg-layer-0, #1e1e1e)',
            border: '1px solid var(--dsw-alias-border-l2, rgba(128,128,128,0.35))',
            borderRadius: '10px',
            padding: '18px 20px',
            boxShadow: '0 8px 30px rgba(0,0,0,0.35)',
          },
        },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '14px' } },
            React.createElement('div', { style: { fontSize: '15px', fontWeight: 600, lineHeight: '22px' } }, title),
            React.createElement('button', {
              type: 'button',
              onClick: onClose,
              style: { background: 'none', border: 'none', cursor: 'pointer', fontSize: '16px', color: 'var(--dsw-alias-label-secondary, #999)' },
            }, '✕'),
          ),
          children,
        ),
      )
    }

    // ---- 新建/编辑弹窗 ----
    function JobFormModal({ job, onClose, onSaved }) {
      const [name, setName] = React.useState(job ? job.name : '')
      const [schedule, setSchedule] = React.useState(job ? job.schedule : '')
      const [prompt, setPrompt] = React.useState(job ? job.prompt : '')
      const [sessionStrategy, setSessionStrategy] = React.useState(job ? job.sessionStrategy : 'new')
      const [fixedSessionId, setFixedSessionId] = React.useState(job && job.sessionStrategy === 'fixed' ? (job.fixedSessionId ?? '') : '')
      const [enabled, setEnabled] = React.useState(job ? job.enabled !== false : true)
      const [saving, setSaving] = React.useState(false)
      const [error, setError] = React.useState(undefined)

      const save = () => {
        if (saving) return
        setSaving(true)
        setError(undefined)
        const body = { name, schedule, prompt, sessionStrategy, enabled }
        if (sessionStrategy === 'fixed') body.fixedSessionId = fixedSessionId
        const isEdit = Boolean(job)
        fetch(isEdit ? `${JOBS_URL}/${job.id}` : JOBS_URL, {
          method: isEdit ? 'PUT' : 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
          .then(readJSON)
          .then(() => onSaved())
          .catch((err) => setError(err instanceof Error ? err.message : String(err)))
          .finally(() => setSaving(false))
      }

      const rowGap = { marginBottom: '12px' }
      const close = () => { if (!saving) onClose() }

      return React.createElement(Modal, { title: job ? '编辑定时任务' : '新建定时任务', onClose: close },
        React.createElement('div', { style: rowGap },
          fieldLabel('名称'),
          React.createElement('input', { value: name, onChange: (e) => setName(e.target.value), placeholder: '例如：早上提醒', disabled: saving, style: inputStyle }),
        ),
        React.createElement('div', { style: rowGap },
          fieldLabel('Cron 表达式'),
          React.createElement('input', { value: schedule, onChange: (e) => setSchedule(e.target.value), placeholder: '0 10 * * *', disabled: saving, style: inputStyle }),
        ),
        React.createElement('div', { style: rowGap },
          fieldLabel('任务提示词'),
          React.createElement('textarea', {
            value: prompt,
            onChange: (e) => setPrompt(e.target.value),
            rows: 4,
            disabled: saving,
            style: Object.assign({}, inputStyle, { resize: 'vertical', fontFamily: 'inherit' }),
          }),
        ),
        React.createElement('div', { style: rowGap },
          fieldLabel('会话策略'),
          React.createElement('select', { value: sessionStrategy, onChange: (e) => setSessionStrategy(e.target.value), disabled: saving, style: inputStyle },
            React.createElement('option', { value: 'new' }, '每次新建'),
            React.createElement('option', { value: 'fixed' }, '固定会话'),
          ),
        ),
        sessionStrategy === 'fixed' ? React.createElement('div', { style: rowGap },
          fieldLabel('固定会话 ID'),
          React.createElement('input', { value: fixedSessionId, onChange: (e) => setFixedSessionId(e.target.value), placeholder: '会话 ID', disabled: saving, style: inputStyle }),
        ) : null,
        React.createElement('div', { style: Object.assign({}, rowGap, { display: 'flex', alignItems: 'center', gap: '8px' }) },
          React.createElement(Toggle, { checked: enabled, disabled: saving, onChange: setEnabled }),
          React.createElement('span', { style: subStyle }, enabled ? '已启用' : '已停用'),
        ),
        error !== undefined ? React.createElement('div', { style: errorStyle }, error) : null,
        React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' } },
          React.createElement('button', { type: 'button', onClick: close, disabled: saving, style: buttonGhost }, '取消'),
          React.createElement('button', { type: 'button', onClick: save, disabled: saving, style: buttonPrimary }, saving ? '保存中…' : '保存'),
        ),
      )
    }

    // ---- 删除确认弹窗 ----
    function DeleteConfirmModal({ job, onClose, onDeleted }) {
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(undefined)

      const remove = () => {
        if (busy) return
        setBusy(true)
        setError(undefined)
        fetch(`${JOBS_URL}/${job.id}`, { method: 'DELETE' })
          .then(readJSON)
          .then(() => onDeleted())
          .catch((err) => setError(err instanceof Error ? err.message : String(err)))
          .finally(() => setBusy(false))
      }

      const close = () => { if (!busy) onClose() }

      return React.createElement(Modal, { title: '删除任务', onClose: close },
        React.createElement('div', { style: { fontSize: '14px', lineHeight: '22px', padding: '4px 0 8px' } },
          `确定删除「${job.name}」？此操作不可撤销。`,
        ),
        error !== undefined ? React.createElement('div', { style: errorStyle }, error) : null,
        React.createElement('div', { style: { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' } },
          React.createElement('button', { type: 'button', onClick: close, disabled: busy, style: buttonGhost }, '取消'),
          React.createElement('button', { type: 'button', onClick: remove, disabled: busy, style: buttonDanger }, busy ? '删除中…' : '删除'),
        ),
      )
    }

    // ---- 主面板 ----
    function CronSettingsPanel() {
      const [jobs, setJobs] = React.useState(undefined) // undefined = 加载中
      const [error, setError] = React.useState(undefined)
      const [modal, setModal] = React.useState(undefined) // {kind:'form', job?} | {kind:'delete', job}
      const [busyId, setBusyId] = React.useState(undefined) // 正在切换启停的任务 id

      const load = React.useCallback(() => {
        fetch(JOBS_URL)
          .then(readJSON)
          .then((value) => {
            setJobs(Array.isArray(value.jobs) ? value.jobs : [])
            setError(undefined)
          })
          .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      }, [])

      React.useEffect(() => {
        load()
        let source
        try {
          source = new EventSource(EVENTS_URL)
          source.addEventListener('jobs-changed', () => load())
        } catch {
          // EventSource 不可用时：挂载与本地变更后的 load() 仍保证列表同步
        }
        return () => { if (source) source.close() }
      }, [load])

      const toggleJob = (job, next) => {
        setBusyId(job.id)
        fetch(`${JOBS_URL}/${job.id}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: next }),
        })
          .then(readJSON)
          .then(() => load())
          .catch((err) => setError(err instanceof Error ? err.message : String(err)))
          .finally(() => setBusyId(undefined))
      }

      const refresh = () => { setModal(undefined); load() }

      let body
      if (jobs === undefined) {
        if (error !== undefined) {
          body = React.createElement(ErrorText, { message: error })
        } else {
          body = React.createElement('div', { style: { padding: '14px 16px', fontSize: '13px', color: 'var(--dsw-alias-label-secondary, #888)' } }, '加载中…')
        }
      } else if (jobs.length === 0) {
        body = React.createElement('div', { style: { padding: '18px 16px', fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-secondary, #888)' } },
          '暂无定时任务，点击「+ 新建任务」或在对话中告诉我')
      } else {
        body = React.createElement('div', null,
          jobs.map((job) => React.createElement(JobCard, {
            key: job.id,
            job,
            busy: busyId === job.id,
            onToggle: toggleJob,
            onEdit: (j) => setModal({ kind: 'form', job: j }),
            onDelete: (j) => setModal({ kind: 'delete', job: j }),
          })),
        )
      }

      return React.createElement(SectionBoundary, null,
        React.createElement('div', null,
          React.createElement('div', { style: rowStyle },
            React.createElement('div', { style: { fontSize: '15px', fontWeight: 600, lineHeight: '22px' } }, '⏰ 定时任务'),
            React.createElement('button', { type: 'button', onClick: () => setModal({ kind: 'form' }), style: buttonPrimary }, '+ 新建任务'),
          ),
          error !== undefined && jobs !== undefined ? React.createElement('div', { style: errorStyle }, '加载失败: ', error) : null,
          body,
          modal !== undefined && modal.kind === 'form' ? React.createElement(JobFormModal, {
            job: modal.job,
            onClose: () => setModal(undefined),
            onSaved: refresh,
          }) : null,
          modal !== undefined && modal.kind === 'delete' ? React.createElement(DeleteConfirmModal, {
            job: modal.job,
            onClose: () => setModal(undefined),
            onDeleted: refresh,
          }) : null,
        ),
      )
    }

    // ---- Cordis 插件出口（slot 注册机制与 dshmarket/heartbeat 一致） ----
    function apply(ctx) {
      ctx.slots.inject('settings.section', () => {
        const off = ctx.slots.register({
          name: 'settings.section',
          id: 'cron',
          order: 50,
          label: () => '⏰ 定时任务',
        }, () => React.createElement(CronSettingsPanel, {}))
        return off
      })
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
