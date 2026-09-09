/**
 * dsh-plugin-cron-scheduler 客户端半（零构建）：
 * 在侧边栏底部注册「定时任务」列表区块（sidebar.footer.action，新 id，
 * 不替换 cordis-panel）—— 任务列表 + 新建/编辑/删除 + 手动触发 + SSE 同步。
 *
 * 数据通道：直连插件自建 HTTP 路由（/api/cron/*）：
 * GET/POST /api/cron/jobs、PUT/DELETE /api/cron/jobs/:id、
 * POST /api/cron/jobs/:id/run、GET /api/cron/sessions、SSE /api/cron/events。
 *
 * 配色：全部使用主题 token（Theme.listTokens），不硬编码深色 fallback，
 * 缺失时透明/继承，浅色/深色主题都正确显示。
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-cron-scheduler',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    let react = require('react')

    const React = react
    const JOBS_URL = '/api/cron/jobs'
    const SESSIONS_URL = '/api/cron/sessions'
    const EVENTS_URL = '/api/cron/events'

    // ---- 固定实色（不依赖 --dsw-alias-*：侧边栏 footer 作用域里这些变量可能未注入，
    //      导致「全白」看不清。深色系实色，任何主题下都保持清晰对比。） ----
    const V = {
      primary: '#4c8bf5',
      border: '#3a3a42',
      overlay: '#1e1f24',
      surface: '#26272e',
      surface2: '#1e1f24',
      text: '#d8d8de',
      text2: '#9a9aa3',
      danger: '#e5484d',
      success: '#30a46c',
    }

    // 列表高度：锚定到视口可用空间，任务多时容器内滚动，不撑爆侧栏
    const LIST_CAP = 328
    const MARGIN = 12

    // ---- 样式 ----
    const btnGhost = (danger) => ({
      padding: '2px 8px', borderRadius: '5px',
      border: '1px solid ' + (danger ? V.danger : V.border),
      background: 'transparent', cursor: 'pointer', fontSize: '11px',
      color: danger ? V.danger : V.text,
    })
    const btnPrimary = { padding: '3px 12px', borderRadius: '6px', border: 'none', cursor: 'pointer', fontSize: '12px', background: V.primary, color: '#fff' }
    const inputStyle = { width: '100%', boxSizing: 'border-box', padding: '6px 9px', borderRadius: '6px', border: '1px solid ' + V.border, background: V.surface, color: V.text, fontSize: '12px' }
    const labelStyle = { display: 'block', fontSize: '11px', margin: '9px 0 3px', color: V.text2 }

    // ---- 工具 ----
    const readJSON = async (response) => {
      const body = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`)
      return body
    }
    // 执行状态 → 可读文案 + 颜色
    const statusText = (job) => {
      if (job.lastRunStatus === 'success') return { text: '成功', color: V.success }
      if (job.lastRunStatus === 'failed') return { text: '失败', color: V.danger }
      if (job.lastRunStatus === 'skipped') return { text: '跳过', color: V.text2 }
      return { text: '未运行', color: V.text2 }
    }

    // ---- 启用开关 ----
    function Switch({ on, onClick, disabled }) {
      return React.createElement('button', {
        type: 'button', role: 'switch', 'aria-checked': on, disabled,
        onClick: () => onClick(!on),
        style: {
          position: 'relative', width: '30px', height: '17px', borderRadius: '9px',
          border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
          // 关闭态用明显的中性灰，开启态用品牌色；都不透明，保证能看出开关状态
          background: on ? '#4c8bf5' : '#4a4a52',
          opacity: disabled ? 0.5 : 1, flexShrink: 0, transition: 'background .15s',
        },
      }, React.createElement('span', {
        style: { position: 'absolute', top: '2px', left: on ? '15px' : '2px', width: '13px', height: '13px', borderRadius: '7px', background: '#fff', transition: 'left .15s' },
      }))
    }

    // ---- 渲染期兜底 ----
    class SectionBoundary extends React.Component {
      constructor(props) { super(props); this.state = { error: undefined } }
      static getDerivedStateFromError(error) { return { error: error instanceof Error ? error.message : String(error) } }
      render() {
        if (this.state.error !== undefined) {
          return React.createElement('div', { style: { padding: '8px', fontSize: '12px', color: V.danger } }, '加载失败: ', this.state.error)
        }
        return this.props.children
      }
    }

    // ---- 任务行（紧凑：单行，高度贴近按钮；「立即运行」在编辑弹窗里） ----
    function JobRow({ job, busy, onToggle, onEdit, onDelete }) {
      const st = statusText(job)
      return React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', height: '28px', borderBottom: '1px solid ' + V.border } },
        React.createElement(Switch, { on: job.enabled !== false, disabled: busy, onClick: (next) => onToggle(job, next) }),
        React.createElement('div', { style: { flex: 1, minWidth: 0, overflow: 'hidden', display: 'flex', alignItems: 'baseline', gap: '6px' } },
          React.createElement('span', { style: { fontSize: '12px', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: V.text } }, job.name),
          React.createElement('span', { style: { fontSize: '10px', color: V.text2, whiteSpace: 'nowrap' } }, job.schedule),
          React.createElement('span', { style: { fontSize: '10px', color: st.color, flexShrink: 0 } }, st.text),
        ),
        React.createElement('button', { style: btnGhost(false), onClick: () => onEdit(job), title: '编辑' }, '编'),
        React.createElement('button', { style: btnGhost(true), onClick: () => onDelete(job), title: '删除' }, '删'),
      )
    }

    // ---- 弹窗容器 ----
    function Dialog({ title, onClose, footer, children }) {
      return React.createElement('div', {
        style: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
        onClick: (e) => { if (e.target === e.currentTarget) onClose() },
      },
        React.createElement('div', { style: { background: V.surface2, border: '1px solid ' + V.border, borderRadius: '10px', width: '420px', maxWidth: '92vw', maxHeight: '82vh', display: 'flex', flexDirection: 'column', boxShadow: '0 12px 40px rgba(0,0,0,.25)' } },
          React.createElement('div', { style: { padding: '12px 16px', borderBottom: '1px solid ' + V.border, fontSize: '13px', fontWeight: 600, color: V.text, display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
            React.createElement('span', null, title),
            React.createElement('button', { type: 'button', onClick: onClose, style: { background: 'none', border: 'none', cursor: 'pointer', fontSize: '14px', color: V.text2 } }, '✕'),
          ),
          React.createElement('div', { style: { padding: '4px 16px', overflowY: 'auto', flex: 1, color: V.text } }, children),
          footer && React.createElement('div', { style: { padding: '10px 16px', borderTop: '1px solid ' + V.border, display: 'flex', justifyContent: 'flex-end', gap: '8px' } }, footer),
        ),
      )
    }

    // ---- 新建/编辑弹窗 ----
    function JobFormModal({ job, onClose, onSaved, onRun }) {
      const [form, setForm] = React.useState({
        name: (job && job.name) || '', schedule: (job && job.schedule) || '', prompt: (job && job.prompt) || '',
        sessionStrategy: (job && job.sessionStrategy) || 'new', fixedSessionId: (job && job.fixedSessionId) || '', enabled: job ? job.enabled !== false : true,
      })
      const [sessions, setSessions] = React.useState([])
      const [sessionsLoaded, setSessionsLoaded] = React.useState(false)
      const [error, setError] = React.useState(undefined)
      const [saving, setSaving] = React.useState(false)
      const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))

      // 切到固定会话时拉取会话列表填充下拉
      React.useEffect(() => {
        if (form.sessionStrategy !== 'fixed') return
        let alive = true
        fetch(SESSIONS_URL)
          .then(readJSON)
          .then((r) => { if (alive) { setSessions((r && r.sessions) || []); setSessionsLoaded(true) } })
          .catch((e) => { if (alive) { console.error(e); setSessionsLoaded(true) } })
        return () => { alive = false }
      }, [form.sessionStrategy])

      const save = () => {
        if (saving) return
        // 前端必填校验（中文提示，不发请求）
        if (!form.name || !form.name.trim()) { setError('请填写任务名称'); return }
        if (!form.schedule || !form.schedule.trim()) { setError('请填写 Cron 表达式'); return }
        if (!form.prompt || !form.prompt.trim()) { setError('请填写指令'); return }
        if (form.sessionStrategy === 'fixed' && !form.fixedSessionId) { setError('请选择会话'); return }
        setSaving(true)
        setError(undefined)
        const body = { ...form }
        if (body.sessionStrategy === 'new') delete body.fixedSessionId
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

      const field = (k, t, c) => React.createElement('div', null, React.createElement('label', { style: labelStyle }, t), c)
      const sessionOptions = [
        React.createElement('option', { key: '__empty', value: '' }, sessionsLoaded ? '— 选择会话 —' : '加载中…'),
      ].concat((sessions || []).map((s) => React.createElement('option', { key: s.id, value: s.id }, s.label)))

      return React.createElement(Dialog, {
        title: job ? '编辑任务' : '新建任务', onClose: () => { if (!saving) onClose() },
        footer: React.createElement(React.Fragment, null,
          job ? React.createElement('button', { style: Object.assign({}, btnPrimary, { background: V.success, marginRight: 'auto' }), onClick: () => { if (job) { onRun(job); onClose() } }, disabled: saving }, '立即运行') : null,
          React.createElement('button', { style: btnGhost(false), onClick: onClose, disabled: saving }, '取消'),
          React.createElement('button', { style: btnPrimary, onClick: save, disabled: saving }, saving ? '保存中…' : '保存')),
      },
        field('name', '名称', React.createElement('input', { value: form.name, onChange: (e) => set('name', e.target.value), placeholder: '任务名称', disabled: saving, style: inputStyle })),
        field('schedule', 'Cron（5 字段，如 0 10 * * *）', React.createElement('input', { value: form.schedule, onChange: (e) => set('schedule', e.target.value), placeholder: '0 10 * * *', disabled: saving, style: inputStyle })),
        field('prompt', '指令（到时注入给 agent）', React.createElement('textarea', { value: form.prompt, onChange: (e) => set('prompt', e.target.value), rows: 4, disabled: saving, style: Object.assign({}, inputStyle, { resize: 'vertical', fontFamily: 'inherit' }) })),
        field('sessionStrategy', '会话策略', React.createElement('select', { value: form.sessionStrategy, onChange: (e) => set('sessionStrategy', e.target.value), disabled: saving, style: inputStyle },
          React.createElement('option', { value: 'new' }, '每次新建'),
          React.createElement('option', { value: 'fixed' }, '固定会话'),
        )),
        form.sessionStrategy === 'fixed' ? field('fixedSessionId', '选择会话', React.createElement('select', { value: form.fixedSessionId, onChange: (e) => set('fixedSessionId', e.target.value), disabled: saving, style: inputStyle }, sessionOptions)) : null,
        error !== undefined ? React.createElement('div', { style: { color: V.danger, fontSize: '11px', marginTop: '8px' } }, error) : null,
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
      return React.createElement(Dialog, {
        title: '删除任务', onClose: () => { if (!busy) onClose() },
        footer: React.createElement(React.Fragment, null,
          React.createElement('button', { style: btnGhost(false), onClick: onClose, disabled: busy }, '取消'),
          React.createElement('button', { style: btnGhost(true), onClick: remove, disabled: busy }, busy ? '删除中…' : '删除')),
      },
        React.createElement('p', { style: { fontSize: '12px', margin: '6px 0 0' } }, `确定删除「${job.name}」？此操作不可撤销。`),
        error !== undefined ? React.createElement('div', { style: { color: V.danger, fontSize: '11px', marginTop: '8px' } }, error) : null,
      )
    }

    // ---- 主面板 ----
    function CronPanel({ wide }) {
      const [jobs, setJobs] = React.useState(undefined)
      const [error, setError] = React.useState(undefined)
      const [modal, setModal] = React.useState(undefined)
      const [busyId, setBusyId] = React.useState(undefined)
      const listRef = React.useRef(null)
      const [maxH, setMaxH] = React.useState(LIST_CAP)

      // 自实现锚定最大高度（等同 ui-primitives useAnchoredMaxHeight）
      React.useEffect(() => {
        const el = listRef.current
        if (!el) return
        const fit = () => setMaxH(Math.min(LIST_CAP, Math.max(0, el.getBoundingClientRect().bottom - MARGIN)))
        fit()
        window.addEventListener('resize', fit)
        window.addEventListener('scroll', fit, true)
        return () => { window.removeEventListener('resize', fit); window.removeEventListener('scroll', fit, true) }
      }, [])

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
        } catch { /* EventSource 不可用：挂载与本地变更后的 load() 仍保证同步 */ }
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

      const runJob = (job) => {
        setBusyId(job.id)
        fetch(`${JOBS_URL}/${job.id}/run`, { method: 'POST' })
          .then(readJSON)
          .then(() => load())
          .catch((err) => setError(err instanceof Error ? err.message : String(err)))
          .finally(() => setBusyId(undefined))
      }

      const refresh = () => { setModal(undefined); load() }

      // 折叠 rail 态：只显示紧凑时钟符号
      if (!wide) {
        return React.createElement('div', { style: { padding: '5px 0', textAlign: 'center', fontSize: '11px', color: V.text2 } }, '⏱')
      }

      return React.createElement(SectionBoundary, null,
        React.createElement('div', { style: { padding: '6px 8px' } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '4px' } },
            React.createElement('span', { style: { fontSize: '12px', fontWeight: 600, color: V.text } }, '定时任务'),
            React.createElement('button', { style: btnPrimary, onClick: () => setModal({ kind: 'form' }) }, '+ 新建'),
          ),
          error !== undefined ? React.createElement('div', { style: { color: V.danger, fontSize: '10px', padding: '2px 0' } }, '加载失败: ', error) : null,
          jobs === undefined ? React.createElement('div', { style: { padding: '6px 0', textAlign: 'center', color: V.text2, fontSize: '11px' } }, '加载中…') : null,
          (jobs && jobs.length === 0 && !error) ? React.createElement('div', { style: { padding: '6px 0', color: V.text2, fontSize: '11px' } }, '暂无定时任务') : null,
          React.createElement('div', { ref: listRef, style: { maxHeight: maxH, overflowY: 'auto' } },
            (jobs || []).map((job) => React.createElement(JobRow, {
              key: job.id, job, busy: busyId === job.id,
              onToggle: toggleJob, onEdit: (j) => setModal({ kind: 'form', job: j }),
              onDelete: (j) => setModal({ kind: 'delete', job: j }),
            })),
          ),
          modal !== undefined && modal.kind === 'form' ? React.createElement(JobFormModal, {
            job: modal.job, onClose: () => setModal(undefined), onSaved: refresh, onRun: runJob,
          }) : null,
          modal !== undefined && modal.kind === 'delete' ? React.createElement(DeleteConfirmModal, {
            job: modal.job, onClose: () => setModal(undefined), onDeleted: refresh,
          }) : null,
        ),
      )
    }

    // ---- Cordis 插件出口：注册到 sidebar.footer.action（新 id，不碰 cordis-panel） ----
    function apply(ctx) {
      ctx.slots.inject('sidebar.footer.action', () => {
        const off = ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'cron-hotplug',
          order: -10,
          label: () => '定时任务',
        }, (ownerProps) => React.createElement(CronPanel, { wide: !!(ownerProps && ownerProps.wide) }))
        return off
      })
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
