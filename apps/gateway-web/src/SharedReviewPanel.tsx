import { useEffect, useState } from 'react'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'

type SharedReview = { id: string; step_key: string; report?: { summary?: string } | null;
  started_at?: string | null }
type Decision = 'approve' | 'reject' | 'force_approve' | 'terminate' | 'complete_task'
const decisions: Array<{ value: Decision; label: string }> = [
  { value: 'approve', label: '通过' },
  { value: 'reject', label: '驳回' },
  { value: 'force_approve', label: '强制通过' },
  { value: 'terminate', label: '终止任务' },
  { value: 'complete_task', label: '完成任务' },
]

export function SharedReviewPanel({ base, csrf, onUpdated }: {
  base: string; csrf: string; onUpdated: () => Promise<void>
}) {
  const [reviews, setReviews] = useState<SharedReview[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [forms, setForms] = useState<Record<string, { decision: Decision; comment: string }>>({})
  const [confirmReview, setConfirmReview] = useState<SharedReview | null>(null)

  async function load() {
    setLoading(true)
    setError('')
    try {
      const response = await fetch(`${base}/reviews`)
      if (!response.ok) { setError('审核列表暂时不可用，请重试。'); return }
      const result = await response.json() as { reviews: SharedReview[] }
      setReviews(result.reviews)
    } catch {
      setError('审核列表暂时不可用，请重试。')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [base])

  async function submit() {
    if (!confirmReview || busy) return
    const form = forms[confirmReview.id] ?? { decision: 'approve', comment: '' }
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`${base}/steps/${encodeURIComponent(confirmReview.step_key)}/review/${form.decision}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Share-CSRF': csrf },
        body: JSON.stringify({ review_run_id: confirmReview.id, comment: form.comment.trim() || null }),
      })
      if (!response.ok) { setError('审核决定未提交，请检查当前审核状态后重试。'); return }
      setConfirmReview(null)
      setForms(current => {
        const next = { ...current }
        delete next[confirmReview.id]
        return next
      })
      await load()
      await onUpdated()
    } catch {
      setError('暂时无法连接宿主电脑，请稍后重试。')
    } finally {
      setBusy(false)
    }
  }

  return <section className="gateway-share-messages gateway-share-reviews">
    <h3>手工审核</h3>
    {loading && <p>正在读取审核…</p>}
    {error && <p className="gateway-share-error" role="alert">{error}</p>}
    {!loading && <>
      {reviews.length === 0 && !error && <p>暂无待处理的手工审核。</p>}
      {reviews.map(review => <article key={review.id} className="gateway-share-message">
        <strong>{review.step_key}</strong>
        {review.report?.summary && <p>{review.report.summary}</p>}
        {review.started_at && <time>{new Date(review.started_at).toLocaleString()}</time>}
        <label htmlFor={`gateway-review-decision-${review.id}`}>审核决定</label>
        <select id={`gateway-review-decision-${review.id}`}
          value={forms[review.id]?.decision ?? 'approve'}
          onChange={event => setForms(current => ({ ...current,
            [review.id]: { decision: event.target.value as Decision,
              comment: current[review.id]?.comment ?? '' },
          }))}>
          {decisions.map(option => <option key={option.value} value={option.value}>
            {option.label}
          </option>)}
        </select>
        <label htmlFor={`gateway-review-comment-${review.id}`}>审核备注</label>
        <textarea id={`gateway-review-comment-${review.id}`} rows={3}
          value={forms[review.id]?.comment ?? ''}
          onChange={event => setForms(current => ({ ...current,
            [review.id]: { decision: current[review.id]?.decision ?? 'approve',
              comment: event.target.value },
          }))} />
        <button type="button" disabled={busy || !csrf}
          onClick={() => setConfirmReview(review)}>提交审核决定</button>
      </article>)}
      <button type="button" disabled={busy} onClick={() => void load()}>刷新审核</button>
    </>}
    {confirmReview && <GatewayConfirmDialog title="确认审核决定"
      message={`对步骤 ${confirmReview.step_key} 提交“${decisions.find(item => item.value === (forms[confirmReview.id]?.decision ?? 'approve'))?.label}”？`}
      confirmLabel="确认提交" busy={busy}
      onConfirm={() => void submit()} onCancel={() => setConfirmReview(null)} />}
  </section>
}
