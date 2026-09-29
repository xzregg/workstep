import { useEffect, useState, type FormEvent } from 'react'
import { useParams } from 'react-router-dom'
import { SharedMessageEvents } from './SharedMessageEvents'
import { SharedStepChat } from './SharedStepChat'
import { SharedReviewPanel } from './SharedReviewPanel'
import { SharedInteractionPanel } from './SharedInteractionPanel'
import { SharedArtifactItem, type SharedArtifact } from './SharedArtifactItem'

type ShareMeta = { title: string; mode: 'read_only' | 'interactive'; has_password: boolean }
type SharedTask = {
  id: string
  title: string
  description?: string | null
  status: string
  created_at?: string | null
  updated_at?: string | null
  creator_name?: string | null
  steps?: Array<{ step_key: string; status: string; has_history: boolean }>
}
type SharedMessage = { id: string; role: string; content: string; step_key: string;
  created_at: string; truncated?: boolean }
type Phase = 'loading' | 'password' | 'task' | 'offline' | 'unavailable'

export function PublicSharePage() {
  const { token } = useParams()
  const [phase, setPhase] = useState<Phase>('loading')
  const [meta, setMeta] = useState<ShareMeta | null>(null)
  const [task, setTask] = useState<SharedTask | null>(null)
  const [messages, setMessages] = useState<SharedMessage[]>([])
  const [nextOffset, setNextOffset] = useState<number | null>(null)
  const [historyBusy, setHistoryBusy] = useState(false)
  const [artifacts, setArtifacts] = useState<SharedArtifact[]>([])
  const [historyError, setHistoryError] = useState(false)
  const [artifactError, setArtifactError] = useState(false)
  const [password, setPassword] = useState('')
  const [shareCsrf, setShareCsrf] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const base = `/api/public/shares/${encodeURIComponent(token ?? '')}`

  async function loadTask(signal?: AbortSignal) {
    const response = await fetch(`${base}/task`, { signal })
    if (signal?.aborted) return
    if (response.status === 503) { setPhase('offline'); return }
    if (response.status === 401) { setPhase('password'); return }
    if (!response.ok) { setPhase('unavailable'); return }
    setTask(await response.json() as SharedTask)
    if (signal?.aborted) return
    setPhase('task')
    try {
      const history = await fetch(`${base}/history`, { signal })
      if (signal?.aborted) return
      if (!history.ok) setHistoryError(true)
      else {
        const result: { messages: SharedMessage[]; next_offset?: number | null } = await history.json()
        if (!signal?.aborted) {
          setMessages(result.messages)
          setNextOffset(result.next_offset ?? null)
        }
      }
    } catch (reason) {
      if (!(reason instanceof DOMException && reason.name === 'AbortError')) setHistoryError(true)
    }
    try {
      const response = await fetch(`${base}/artifacts`, { signal })
      if (signal?.aborted) return
      if (!response.ok) { setArtifactError(true); return }
      const result: { artifacts: SharedArtifact[] } = await response.json()
      if (!signal?.aborted) setArtifacts(result.artifacts)
    } catch (reason) {
      if (!(reason instanceof DOMException && reason.name === 'AbortError')) setArtifactError(true)
    }
  }

  useEffect(() => {
    const controller = new AbortController()
    setPhase('loading')
    setMeta(null)
    setTask(null)
    setMessages([])
    setNextOffset(null)
    setArtifacts([])
    setHistoryError(false)
    setArtifactError(false)
    setError('')
    setShareCsrf('')
    async function openShare() {
      try {
        if (!token) { setPhase('unavailable'); return }
        const response = await fetch(`${base}/meta`, { signal: controller.signal })
        if (controller.signal.aborted) return
        if (response.status === 503) { setPhase('offline'); return }
        if (!response.ok) { setPhase('unavailable'); return }
        const currentMeta = await response.json() as ShareMeta
        if (controller.signal.aborted) return
        setMeta(currentMeta)
        const session = await fetch(`${base}/session`, { signal: controller.signal })
        if (controller.signal.aborted) return
        if (session.ok) {
          const details = await session.json() as { csrf_token?: string }
          setShareCsrf(details.csrf_token ?? '')
          await loadTask(controller.signal); return
        }
        if (session.status !== 401) { setPhase('unavailable'); return }
        if (currentMeta.has_password) { setPhase('password'); return }
        const unlocked = await fetch(`${base}/unlock`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: '' }), signal: controller.signal,
        })
        if (controller.signal.aborted) return
        if (!unlocked.ok) { setPhase('unavailable'); return }
        const unlockedSession = await unlocked.json() as { csrf_token?: string }
        setShareCsrf(unlockedSession.csrf_token ?? '')
        await loadTask(controller.signal)
      } catch (reason) {
        if (!(reason instanceof DOMException && reason.name === 'AbortError')) setPhase('offline')
      }
    }
    void openShare()
    return () => controller.abort()
  }, [token, revision])

  async function unlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!password.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`${base}/unlock`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (response.status === 403) { setError('密码错误，请重试。'); return }
      if (response.status === 503) { setPhase('offline'); return }
      if (!response.ok) { setPhase('unavailable'); return }
      const unlockedSession = await response.json() as { csrf_token?: string }
      setShareCsrf(unlockedSession.csrf_token ?? '')
      await loadTask()
    } catch {
      setPhase('offline')
    } finally {
      setBusy(false)
    }
  }

  async function loadOlder() {
    if (nextOffset === null || historyBusy) return
    setHistoryBusy(true)
    setHistoryError(false)
    try {
      const response = await fetch(`${base}/history/${nextOffset}`)
      if (!response.ok) { setHistoryError(true); return }
      const result: { messages: SharedMessage[]; next_offset: number | null } = await response.json()
      setMessages(current => [...result.messages, ...current])
      setNextOffset(result.next_offset)
    } catch {
      setHistoryError(true)
    } finally {
      setHistoryBusy(false)
    }
  }

  return <main className="gateway-share-page">
    <header className="gateway-share-header"><h1>WorkStep 分享</h1></header>
    <section className="gateway-share-card" aria-live="polite">
      {phase === 'loading' && <p className="gateway-share-pending">正在打开分享…</p>}
      {phase === 'password' && <>
        <p className="gateway-share-eyebrow">受保护的任务分享</p>
        <h2>{meta?.title || '查看任务'}</h2>
        <p>输入分享密码后查看任务。</p>
        <form className="gateway-share-form" onSubmit={unlock}>
          <label htmlFor="gateway-share-password">分享密码</label>
          <input id="gateway-share-password" type="password" autoComplete="off"
            value={password} onChange={event => setPassword(event.target.value)} />
          {error && <p className="gateway-share-error" role="alert">{error}</p>}
          <button type="submit" disabled={!password.trim() || busy}>
            {busy && <span className="gateway-share-spinner" aria-hidden="true" />}
            {busy ? '正在验证…' : '查看任务'}
          </button>
        </form>
      </>}
      {phase === 'task' && task && <>
        <p className="gateway-share-eyebrow">{meta?.mode === 'interactive' ? '互动分享' : '只读分享'}</p>
        <h2>{task.title}</h2>
        {meta?.title && <p className="gateway-share-caption">{meta.title}</p>}
        <dl className="gateway-share-facts"><div><dt>状态</dt><dd>{task.status}</dd></div>
          {task.creator_name && <div><dt>创建者</dt><dd>{task.creator_name}</dd></div>}
          {task.created_at && <div><dt>创建时间</dt><dd>{new Date(task.created_at).toLocaleString()}</dd></div>}
        </dl>
        {task.description && <div className="gateway-share-description">{task.description}</div>}
        {meta?.mode === 'interactive' && <SharedStepChat base={base} csrf={shareCsrf}
          steps={task.steps ?? []} onUpdated={loadTask} />}
        {meta?.mode === 'interactive' && <SharedReviewPanel base={base} csrf={shareCsrf}
          onUpdated={loadTask} />}
        {meta?.mode === 'interactive' && <SharedInteractionPanel base={base}
          csrf={shareCsrf} onUpdated={loadTask} />}
        <section className="gateway-share-messages">
          <h3>任务消息</h3>
          {historyError && <p>消息暂时不可用，请稍后重试。</p>}
          {!historyError && messages.length === 0 && <p>暂无执行消息。</p>}
          {nextOffset !== null && <button type="button" disabled={historyBusy}
            onClick={() => void loadOlder()}>
            {historyBusy && <span className="gateway-share-spinner" aria-hidden="true" />}
            {historyBusy ? '正在加载…' : '加载更早消息'}
          </button>}
          {messages.map(message => <article key={message.id} className="gateway-share-message">
            <div className="gateway-share-message-meta">
              <strong>{message.role === 'assistant' ? '助手' : '用户'}</strong>
              {message.step_key && <span>{message.step_key}</span>}
              {message.created_at && <time>{new Date(message.created_at).toLocaleString()}</time>}
            </div>
            <div className="gateway-share-message-content">{message.content}</div>
            {message.truncated && <p>消息过长，仅显示前一部分。</p>}
            <SharedMessageEvents base={base} messageId={message.id} />
          </article>)}
        </section>
        <section className="gateway-share-messages">
          <h3>任务产物</h3>
          {artifactError && <p>产物暂时不可用，请稍后重试。</p>}
          {!artifactError && artifacts.length === 0 && <p>暂无产物。</p>}
          {artifacts.map(artifact => <SharedArtifactItem key={artifact.id} base={base}
            artifact={artifact} />)}
        </section>
      </>}
      {phase === 'offline' && <>
        <h2>暂时无法打开分享</h2>
        <p>宿主电脑暂时不可用，请稍后重试。</p>
        <button type="button" onClick={() => setRevision(value => value + 1)}>重试</button>
      </>}
      {phase === 'unavailable' && <>
        <h2>分享不可用</h2>
        <p>链接可能已过期或被撤销。</p>
      </>}
    </section>
  </main>
}
