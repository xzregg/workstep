import { useEffect, useState, type FormEvent } from 'react'
import { Link, useLocation, useSearchParams } from 'react-router-dom'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'

type CreatedShare = { id: string; url: string; status: string; mode: string; title: string }
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export function GatewayShareCreatePage() {
  const [params] = useSearchParams()
  const location = useLocation()
  const projectId = params.get('project_id') ?? ''
  const taskId = params.get('task_id') ?? ''
  const validTarget = PROJECT_ID.test(projectId) && TASK_ID.test(taskId)
  const [auth, setAuth] = useState<'checking' | 'ready' | 'login'>('checking')
  const [csrfToken, setCsrfToken] = useState('')
  const [title, setTitle] = useState('')
  const [mode, setMode] = useState<'read_only' | 'interactive'>('read_only')
  const [password, setPassword] = useState('')
  const [expiresAt, setExpiresAt] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [created, setCreated] = useState<CreatedShare | null>(null)
  const [revoked, setRevoked] = useState(false)
  const [confirmRevoke, setConfirmRevoke] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!validTarget) return
    const controller = new AbortController()
    fetch('/api/auth/session', { signal: controller.signal })
      .then(async response => {
        if (!response.ok) { setAuth('login'); return }
        const session: { csrf_token: string } = await response.json()
        if (!controller.signal.aborted) {
          setCsrfToken(session.csrf_token)
          setAuth('ready')
        }
      })
      .catch(reason => { if (reason?.name !== 'AbortError') setAuth('login') })
    return () => controller.abort()
  }, [projectId, taskId, validTarget])

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!validTarget || !csrfToken || busy || password && password.length < 4) return
    setBusy(true)
    setError('')
    try {
      const response = await fetch('/api/platform-shares', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({
          project_id: projectId, task_id: taskId, mode,
          title: title.trim(), password: password || null,
          expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
        }),
      })
      if (response.status === 403) { setError('当前账户没有此项目的分享创建权限。'); return }
      if (response.status === 404) { setError('项目已停止发布或不可用。'); return }
      if (!response.ok) { setError('创建分享失败，请检查输入后重试。'); return }
      setCreated(await response.json() as CreatedShare)
    } catch { setError('无法连接 Gateway，请稍后重试。') }
    finally { setBusy(false) }
  }

  async function revoke() {
    if (!created || busy) return
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`/api/platform-shares/${encodeURIComponent(created.id)}/revoke`, {
        method: 'POST', headers: { 'X-CSRF-Token': csrfToken },
      })
      if (!response.ok) { setError('撤销失败，请重试。'); return }
      setRevoked(true)
      setConfirmRevoke(false)
    } catch { setError('无法连接 Gateway，请稍后重试。') }
    finally { setBusy(false) }
  }

  async function copyLink() {
    if (!created) return
    try { await navigator.clipboard.writeText(created.url); setCopied(true) }
    catch { setError('复制失败，请手动选择链接。') }
  }

  return <section className="gateway-auth-card gateway-share-create-page">
    <span className="gateway-auth-eyebrow">WORKSTEP SHARE</span>
    <h2>创建平台分享</h2>
    {!validTarget && <p role="alert">缺少有效的项目或任务标识，请从任务详情重新打开。</p>}
    {validTarget && auth === 'checking' && <p role="status">正在检查账户…</p>}
    {validTarget && auth === 'login' && <p>
      请先在 Gateway 登录。<Link to={`/auth?next=${encodeURIComponent(location.pathname + location.search)}`}>前往登录</Link>
    </p>}
    {validTarget && auth === 'ready' && !created && <form className="gateway-auth-form"
      onSubmit={event => void create(event)}>
      <p>任务：{taskId}</p>
      <label htmlFor="gateway-share-title">分享标题</label>
      <input id="gateway-share-title" value={title} maxLength={256}
        onChange={event => setTitle(event.target.value)} />
      <label htmlFor="gateway-share-mode">访问方式</label>
      <select id="gateway-share-mode" value={mode}
        onChange={event => setMode(event.target.value as 'read_only' | 'interactive')}>
        <option value="read_only">只读</option>
        <option value="interactive">互动</option>
      </select>
      <label htmlFor="gateway-share-new-password">分享密码（可选）</label>
      <input id="gateway-share-new-password" type="password" autoComplete="new-password"
        value={password} minLength={4} maxLength={200}
        onChange={event => setPassword(event.target.value)} />
      <label htmlFor="gateway-share-expiry">过期时间（可选）</label>
      <input id="gateway-share-expiry" type="datetime-local" value={expiresAt}
        onChange={event => setExpiresAt(event.target.value)} />
      {error && <p className="gateway-auth-error" role="alert">{error}</p>}
      <button type="submit" disabled={busy || (!!password && password.length < 4)}>
        {busy && <span className="gateway-share-spinner" aria-hidden="true" />}
        {busy ? '正在创建…' : '创建分享'}
      </button>
    </form>}
    {created && <div className="gateway-share-created">
      <p>{revoked ? '分享已撤销。' : '分享已创建。'}</p>
      {!revoked && <>
        <label htmlFor="gateway-created-share-url">分享链接</label>
        <input id="gateway-created-share-url" readOnly value={created.url} />
        <div className="gateway-share-create-actions">
          <a href={created.url} target="_blank" rel="noopener noreferrer">打开分享链接</a>
          <button type="button" onClick={() => void copyLink()}>{copied ? '已复制' : '复制链接'}</button>
          <button type="button" onClick={() => setConfirmRevoke(true)}>撤销分享</button>
        </div>
      </>}
      {error && <p className="gateway-auth-error" role="alert">{error}</p>}
    </div>}
    {confirmRevoke && <GatewayConfirmDialog title="确认撤销分享"
      message="撤销后，访客将无法再使用此链接。" confirmLabel="确认撤销"
      busy={busy} onConfirm={() => void revoke()} onCancel={() => setConfirmRevoke(false)} />}
  </section>
}
