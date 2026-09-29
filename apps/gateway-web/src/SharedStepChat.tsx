import { useState, type FormEvent } from 'react'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'

type SharedStep = { step_key: string; status: string; has_history: boolean }
const active = new Set(['running', 'reviewing'])
const waiting = new Set(['retrying', 'rework', 'rework_waiting'])
const resumable = new Set(['cancelled', 'failed', 'rejected', 'awaiting_review', 'passed', 'skipped'])

export function SharedStepChat({ base, csrf, steps, onUpdated }: {
  base: string; csrf: string; steps: SharedStep[]; onUpdated: () => Promise<void>
}) {
  const [target, setTarget] = useState('')
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [stopTarget, setStopTarget] = useState<string | null>(null)
  const options = steps.filter(step => active.has(step.status)
    || (!waiting.has(step.status) && (resumable.has(step.status) || step.has_history)))
  const selected = options.find(step => step.step_key === target) ?? options[0]

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!selected || !content.trim() || busy) return
    setBusy(true)
    setError('')
    try {
      const action = active.has(selected.status) ? 'message' : 'resume'
      const response = await fetch(`${base}/steps/${encodeURIComponent(selected.step_key)}/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Share-CSRF': csrf },
        body: JSON.stringify({ content: content.trim() }),
      })
      if (!response.ok) { setError('消息发送失败，请检查步骤状态后重试。'); return }
      setContent('')
      await onUpdated()
    } catch {
      setError('暂时无法连接宿主电脑，请稍后重试。')
    } finally {
      setBusy(false)
    }
  }

  async function stop() {
    if (!stopTarget || busy) return
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`${base}/steps/${encodeURIComponent(stopTarget)}/cancel`, {
        method: 'POST', headers: { 'X-Share-CSRF': csrf },
      })
      if (!response.ok) { setError('停止步骤失败，请稍后重试。'); return }
      setStopTarget(null)
      await onUpdated()
    } catch {
      setError('暂时无法连接宿主电脑，请稍后重试。')
    } finally {
      setBusy(false)
    }
  }

  return <section className="gateway-share-messages gateway-share-step-chat">
    <h3>与执行步骤交互</h3>
    {options.length === 0 ? <p>目前没有可发送消息的步骤。</p> : <form onSubmit={send}>
      <label htmlFor="gateway-share-step-target">发送给步骤</label>
      <select id="gateway-share-step-target" value={selected?.step_key ?? ''}
        onChange={event => setTarget(event.target.value)}>
        {options.map(step => <option key={step.step_key} value={step.step_key}>
          {step.step_key} · {step.status}
        </option>)}
      </select>
      <label htmlFor="gateway-share-step-content">消息内容</label>
      <textarea id="gateway-share-step-content" value={content}
        onChange={event => setContent(event.target.value)} rows={4} />
      {error && <p className="gateway-share-error" role="alert">{error}</p>}
      <div className="gateway-share-step-actions">
        <button type="submit" disabled={!content.trim() || busy || !csrf}>
          {busy && <span className="gateway-share-spinner" aria-hidden="true" />}
          {busy ? '处理中…' : '发送消息'}
        </button>
        {selected && active.has(selected.status) && <button type="button"
          disabled={busy || !csrf} onClick={() => setStopTarget(selected.step_key)}>
          停止步骤
        </button>}
      </div>
    </form>}
    {stopTarget && <GatewayConfirmDialog title="确认停止步骤"
      message={`停止步骤 ${stopTarget} 的当前执行？`} confirmLabel="停止步骤"
      busy={busy} onConfirm={() => void stop()} onCancel={() => setStopTarget(null)} />}
  </section>
}
