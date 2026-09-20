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
 *
 * 自适应（v0.2.8，方案 A+B+C）：
 *  - C：footer 只留一个紧凑入口（CronLauncher：时钟 + 文案 + 数量 + 失败点），
 *       管理器整体搬到 shell.overlay 弹层里，因此 footer 内容天然不受侧栏宽度影响；
 *  - A：弹层内的任务行仍不设硬宽度（width:100% / min-width:0）、允许省略号收缩、
 *       列表容器 overflow-x 强制 hidden（否则 overflow-y:auto 会连带打开横向滚动条）；
 *  - B：弹层内容按 ResizeObserver 实测宽度分档（full/compact/minimal）决定
 *       Cron 表达式与状态文字显隐，窄窗口下也不溢出、按钮始终可点。
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

    // ---- 主题语义变量（与 cordis-panel/dshmarket 同源，自动跟随浅色/深色主题。
    //      主按钮用 button-primary-fill 背景 + label-primary-inverted 反色文字，
    //      两者配对随主题翻转，保证任何主题下都清晰、不突兀。） ----
    const V = {
      primary: 'var(--dsw-alias-button-primary-fill)',
      primaryText: 'var(--dsw-alias-label-primary-inverted)',
      border: 'var(--dsw-alias-border-l1)',
      overlay: 'var(--dsw-alias-bg-base)',
      surface: 'var(--dsw-alias-bg-layer-1)',
      surface2: 'var(--dsw-alias-bg-base)',
      text: 'var(--dsw-alias-label-primary)',
      text2: 'var(--dsw-alias-label-secondary)',
      danger: 'var(--dsw-alias-state-error-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
    }

    // 列表高度：锚定到视口可用空间，任务多时容器内滚动（弹层里放宽到 420px）
    const LIST_CAP = 420
    const MARGIN = 12

    // ---- 样式 ----
    // 响应式分档阈值（按面板实测宽度切档，见 CronPanel 的 ResizeObserver）：
    //   full    ≥ 300px：名称 + Cron 表达式 + 状态文字 + 编/删
    //   compact 220~299：名称 + 状态文字 + 编/删（表达式收进 tooltip）
    //   minimal < 220px：名称 + 状态色点 + 编/删（状态文字收进 tooltip）
    const TIER_FULL = 300
    const TIER_COMPACT = 220

    const btnGhost = (danger) => ({
      padding: '2px 8px', borderRadius: '5px',
      border: '1px solid ' + (danger ? V.danger : V.border),
      background: 'transparent', cursor: 'pointer', fontSize: '11px',
      color: danger ? V.danger : V.text,
      // 窄侧栏下按钮先保证自身完整，让名称/表达式去收缩
      flexShrink: 0,
    })
    const btnPrimary = { padding: '3px 12px', borderRadius: '6px', border: 'none', cursor: 'pointer', fontSize: '12px', background: V.primary, color: V.primaryText, flexShrink: 0 }
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

    // ---- 共享状态 1：管理器的开合（footer 的入口按钮 ↔ shell.overlay 里的管理器） ----
    const overlayState = { open: false }
    const overlayListeners = new Set()
    const setOverlayOpen = (next) => {
      if (overlayState.open === next) return
      overlayState.open = next
      overlayListeners.forEach((listener) => { listener() })
    }
    const useOverlayOpen = () => {
      const [open, setOpen] = React.useState(overlayState.open)
      React.useEffect(() => {
        const listener = () => setOpen(overlayState.open)
        overlayListeners.add(listener)
        listener() // 订阅后立即对齐一次，避免挂载间隙丢事件
        return () => { overlayListeners.delete(listener) }
      }, [])
      return open
    }

    // ---- 共享状态 2：任务数据（入口与管理器共用一次拉取 + 一条 SSE） ----
    const cronStore = { jobs: undefined, error: undefined, source: undefined, refs: 0, listeners: new Set() }
    const cronNotify = () => { cronStore.listeners.forEach((listener) => { listener() }) }
    const cronLoad = () => fetch(JOBS_URL)
      .then(readJSON)
      .then((value) => {
        cronStore.jobs = Array.isArray(value.jobs) ? value.jobs : []
        cronStore.error = undefined
      })
      .catch((err) => { cronStore.error = err instanceof Error ? err.message : String(err) })
      .then(cronNotify)
    const cronSubscribe = (listener) => {
      cronStore.listeners.add(listener)
      cronStore.refs += 1
      if (cronStore.refs === 1) {
        cronLoad()
        try {
          cronStore.source = new EventSource(EVENTS_URL)
          cronStore.source.addEventListener('jobs-changed', () => { cronLoad() })
        } catch { /* EventSource 不可用：挂载与本地变更后的 load() 仍保证同步 */ }
      }
      return () => {
        cronStore.listeners.delete(listener)
        cronStore.refs -= 1
        if (cronStore.refs === 0 && cronStore.source) {
          cronStore.source.close()
          cronStore.source = undefined
        }
      }
    }
    const useCronJobs = () => {
      const [, bump] = React.useReducer((n) => n + 1, 0)
      React.useEffect(() => cronSubscribe(bump), [])
      return { jobs: cronStore.jobs, error: cronStore.error }
    }

    // ---- footer 入口（方案 C：footer 只留一个紧凑入口，管理器搬到弹层，彻底不吃侧栏宽度） ----
    function CronLauncher({ wide }) {
      const { jobs, error } = useCronJobs()
      const [hover, setHover] = React.useState(false)
      const list = jobs || []
      const failed = list.some((job) => job.lastRunStatus === 'failed')
      const enabled = list.filter((job) => job.enabled !== false).length
      const summary = error !== undefined
        ? '定时任务（加载失败: ' + error + '）'
        : '定时任务 · ' + String(list.length) + ' 个任务 / ' + String(enabled) + ' 个启用'
      return React.createElement('button', {
        type: 'button',
        'aria-haspopup': 'dialog',
        'aria-label': '定时任务',
        title: summary,
        onClick: () => setOverlayOpen(true),
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          display: 'flex', alignItems: 'center', gap: '6px', width: '100%', minWidth: 0, boxSizing: 'border-box',
          height: '32px', padding: wide ? '0 8px' : '0', justifyContent: wide ? 'flex-start' : 'center',
          background: hover ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
          border: 'none', borderRadius: '8px', cursor: 'pointer', color: V.text, font: 'inherit',
        },
      },
        React.createElement('span', { style: { flexShrink: 0, fontSize: '14px', lineHeight: '16px' } }, '⏱'),
        wide ? React.createElement('span', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left' } }, '定时任务') : null,
        wide && list.length > 0 ? React.createElement('span', { style: { flexShrink: 0, fontSize: '10px', color: V.text2 } }, String(list.length)) : null,
        wide && failed ? React.createElement('span', { title: '有任务上次执行失败', style: { flexShrink: 0, width: '6px', height: '6px', borderRadius: '3px', background: V.danger } }) : null,
      )
    }

    // ---- 弹层管理器（注册到 shell.overlay；桌面端该层是 fixed 表面的包含块） ----
    function CronOverlay() {
      const open = useOverlayOpen()
      const panelRef = React.useRef(null)
      React.useEffect(() => {
        if (!open) return
        const first = panelRef.current && panelRef.current.querySelector('button')
        if (first) first.focus()
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return
          // 编辑/删除弹窗自己也带 role="dialog"：那时 Esc 归它们处理
          if (document.querySelectorAll('[role="dialog"]').length > 1) return
          setOverlayOpen(false)
        }
        document.addEventListener('keydown', onKeyDown)
        return () => { document.removeEventListener('keydown', onKeyDown) }
      }, [open])
      if (!open) return null
      return React.createElement('div', {
        role: 'dialog', 'aria-modal': 'true', 'aria-label': '定时任务',
        style: { position: 'fixed', inset: 0, zIndex: 900, display: 'flex', alignItems: 'center', justifyContent: 'center', pointerEvents: 'auto' },
      },
        React.createElement('button', {
          type: 'button', 'aria-label': '关闭', tabIndex: -1, onClick: () => setOverlayOpen(false),
          style: { position: 'absolute', inset: 0, border: 'none', margin: 0, padding: 0, background: 'rgba(0,0,0,.4)', cursor: 'default' },
        }),
        React.createElement('section', {
          ref: panelRef,
          style: {
            position: 'relative', display: 'flex', flexDirection: 'column', width: '560px', maxWidth: '92vw', maxHeight: '82vh',
            background: V.surface2, border: '1px solid ' + V.border, borderRadius: '12px',
            boxShadow: '0 16px 48px rgba(0,0,0,.28)', color: V.text,
          },
        },
          React.createElement('header', { style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '12px 16px', borderBottom: '1px solid ' + V.border } },
            React.createElement('h2', { style: { margin: 0, flex: '1 1 auto', minWidth: 0, fontSize: '14px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, '定时任务'),
            React.createElement('button', { type: 'button', 'aria-label': '关闭', onClick: () => setOverlayOpen(false), style: btnGhost(false) }, '✕'),
          ),
          React.createElement('div', { style: { padding: '12px 16px 16px', overflowY: 'auto', overflowX: 'hidden', minWidth: 0 } },
            React.createElement(CronManager, null),
          ),
        ),
      )
    }

    // ---- 启用开关 ----
    function Switch({ on, onClick, disabled }) {
      return React.createElement('button', {
        type: 'button', role: 'switch', 'aria-checked': on, disabled,
        onClick: () => onClick(!on),
        style: {
          position: 'relative', width: '30px', height: '17px', borderRadius: '9px',
          border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
          // 开启态用主按钮填充色，关闭态用中性边框色；都随主题翻转，始终能看清状态
          background: on ? V.primary : 'var(--dsw-alias-border-l2, #8a8a92)',
          opacity: disabled ? 0.5 : 1, flexShrink: 0, transition: 'background .15s',
        },
      }, React.createElement('span', {
        style: { position: 'absolute', top: '2px', left: on ? '15px' : '2px', width: '13px', height: '13px', borderRadius: '7px', background: V.primaryText, transition: 'left .15s' },
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

    // ---- 任务行（紧凑：单行，高度贴近按钮；「立即运行」在编辑弹窗里）
    //      自适应：不设硬宽度，窄侧栏下名称/表达式先省略号收缩，按钮与状态保持完整。 ----
    function JobRow({ job, busy, tier, onToggle, onEdit, onDelete }) {
      const st = statusText(job)
      const showSchedule = tier === 'full'
      const showStatusText = tier !== 'minimal'
      return React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', height: '28px', minWidth: 0, overflow: 'hidden', borderBottom: '1px solid ' + V.border } },
        React.createElement(Switch, { on: job.enabled !== false, disabled: busy, onClick: (next) => onToggle(job, next) }),
        React.createElement('div', { style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', display: 'flex', alignItems: 'baseline', gap: '6px' } },
          React.createElement('span', { title: job.name, style: { fontSize: '12px', fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: V.text, minWidth: 0 } }, job.name),
          showSchedule ? React.createElement('span', { title: job.schedule, style: { fontSize: '10px', color: V.text2, whiteSpace: 'nowrap', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 2 } }, job.schedule) : null,
          showStatusText
            ? React.createElement('span', { title: job.lastRunError || st.text, style: { fontSize: '10px', color: st.color, flexShrink: 0 } }, st.text)
            : React.createElement('span', { title: (job.lastRunError || st.text) + (job.schedule ? ' · ' + job.schedule : ''), style: { flexShrink: 0, width: '6px', height: '6px', borderRadius: '3px', background: st.color } }),
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
          job ? React.createElement('button', { style: Object.assign({}, btnPrimary, { marginRight: 'auto' }), onClick: () => { if (job) { onRun(job); onClose() } }, disabled: saving }, '立即运行') : null,
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

    // ---- 管理器（弹层内容；footer 只留 CronLauncher 入口，管理器不再吃侧栏宽度） ----
    function CronManager() {
      const { jobs, error } = useCronJobs()
      const [actionError, setActionError] = React.useState(undefined)
      const [modal, setModal] = React.useState(undefined)
      const [busyId, setBusyId] = React.useState(undefined)
      const listRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const [maxH, setMaxH] = React.useState(LIST_CAP)
      // 面板宽度分档：footer 是 row 方向的 flex，宿主宽度会被用户拖动改小，
      // 不设硬宽度、按实测宽度降级内容，避免行溢出把按钮挤出可视区。
      const [tier, setTier] = React.useState('full')

      React.useEffect(() => {
        const el = panelRef.current
        if (!el) return
        const measure = () => {
          const width = el.getBoundingClientRect().width
          const next = width >= TIER_FULL ? 'full' : width >= TIER_COMPACT ? 'compact' : 'minimal'
          setTier((prev) => (prev === next ? prev : next))
        }
        measure()
        let observer
        if (typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(measure)
          observer.observe(el)
        } else {
          window.addEventListener('resize', measure)
        }
        return () => {
          if (observer) observer.disconnect()
          else window.removeEventListener('resize', measure)
        }
      }, [])

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

      const toggleJob = (job, next) => {
        setBusyId(job.id)
        setActionError(undefined)
        fetch(`${JOBS_URL}/${job.id}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: next }),
        })
          .then(readJSON)
          .then(() => cronLoad())
          .catch((err) => setActionError(err instanceof Error ? err.message : String(err)))
          .finally(() => setBusyId(undefined))
      }

      const runJob = (job) => {
        setBusyId(job.id)
        setActionError(undefined)
        fetch(`${JOBS_URL}/${job.id}/run`, { method: 'POST' })
          .then(readJSON)
          .then(() => cronLoad())
          .catch((err) => setActionError(err instanceof Error ? err.message : String(err)))
          .finally(() => setBusyId(undefined))
      }

      const refresh = () => { setModal(undefined); setActionError(undefined); cronLoad() }

      return React.createElement(SectionBoundary, null,
        React.createElement('div', { ref: panelRef, style: { width: '100%', minWidth: 0, boxSizing: 'border-box' } },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px', minWidth: 0, marginBottom: '8px' } },
            React.createElement('span', { style: { fontSize: '12px', fontWeight: 600, color: V.text, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
              error !== undefined ? '定时任务' : jobs === undefined ? '加载中…' : jobs.length === 0 ? '暂无定时任务' : String(jobs.length) + ' 个任务'),
            React.createElement('button', { style: btnPrimary, onClick: () => setModal({ kind: 'form' }) }, '+ 新建'),
          ),
          error !== undefined ? React.createElement('div', { style: { color: V.danger, fontSize: '11px', padding: '2px 0' } }, '加载失败: ', error) : null,
          actionError !== undefined ? React.createElement('div', { style: { color: V.danger, fontSize: '11px', padding: '2px 0' } }, actionError) : null,
          React.createElement('div', { ref: listRef, style: { maxHeight: maxH, overflowY: 'auto', overflowX: 'hidden', minWidth: 0 } },
            (jobs || []).map((job) => React.createElement(JobRow, {
              key: job.id, job, tier, busy: busyId === job.id,
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

    // ---- Cordis 插件出口：footer 紧凑入口 + shell.overlay 弹层管理器（新 id，不碰 cordis-panel） ----
    function apply(ctx) {
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name: 'sidebar.footer.action',
        id: 'cron-hotplug',
        order: -10,
        label: () => '定时任务',
      }, (ownerProps) => React.createElement(CronLauncher, { wide: !!(ownerProps && ownerProps.wide) })))
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'cron-hotplug-overlay',
      }, () => React.createElement(CronOverlay)))
    }

    exports.apply = apply
    exports.inject = ['slots']
    return module.exports
  },
})
