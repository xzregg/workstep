import { useEffect, useState } from 'react'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'
import { buildInteractionResponse, cancelInteractionResponse, interactionForm,
  type InteractionRequestData, type InteractionValues } from './shareInteraction'

type PendingInteraction = { interaction_id: string; step_key: string;
  request: InteractionRequestData }

export function SharedInteractionPanel({ base, csrf, onUpdated }: {
  base: string; csrf: string; onUpdated?: () => Promise<void>
}) {
  const [items, setItems] = useState<PendingInteraction[]>([])
  const [values, setValues] = useState<Record<string, InteractionValues>>({})
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState<{ item: PendingInteraction;
    data: Record<string, unknown> } | null>(null)

  async function load() {
    setLoading(true)
    setError('')
    try {
      const response = await fetch(`${base}/interventions`)
      if (!response.ok) { setError('引擎交互暂时不可用，请重试。'); return }
      const result = await response.json() as { interventions: PendingInteraction[] }
      setItems(result.interventions)
    } catch {
      setError('引擎交互暂时不可用，请重试。')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void load() }, [base])

  function updateValue(interactionId: string, fieldId: string,
                       value: string | string[] | boolean | number) {
    setValues(current => ({ ...current,
      [interactionId]: { ...(current[interactionId] ?? {}), [fieldId]: value },
    }))
  }

  async function submit() {
    if (!confirm || busy) return
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`${base}/interventions/${encodeURIComponent(confirm.item.interaction_id)}/respond`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Share-CSRF': csrf },
        body: JSON.stringify({ data: confirm.data }),
      })
      if (!response.ok) { setError('引擎回复未提交，请刷新后重试。'); return }
      setConfirm(null)
      await load()
      await onUpdated?.()
    } catch {
      setError('暂时无法连接宿主电脑，请稍后重试。')
    } finally {
      setBusy(false)
    }
  }

  return <section className="gateway-share-messages gateway-share-interactions">
    <h3>引擎交互</h3>
    {loading && <p>正在读取待处理请求…</p>}
    {error && <p className="gateway-share-error" role="alert">{error}</p>}
    {!loading && <>
      {items.length === 0 && !error && <p>暂无待处理的引擎交互。</p>}
      {items.map(item => {
        const form = interactionForm(item.request)
        const current = values[item.interaction_id] ?? {}
        const complete = form.fields.every(field => {
          if (!field.required) return true
          const value = current[field.id]
          return typeof value === 'boolean' || typeof value === 'number'
            || (Array.isArray(value) ? value.length > 0 : Boolean(value?.trim()))
        })
        const toolInput = item.request.tool_call?.raw_input ?? item.request.tool_call?.input
        return <article key={item.interaction_id} className="gateway-share-message">
          <strong>{form.title}</strong><p>步骤：{item.step_key}</p>
          {item.request.mode === 'url' && item.request.url &&
            <p>请先在指定页面完成操作：{item.request.url}</p>}
          {toolInput !== undefined && <pre>{JSON.stringify(toolInput, null, 2)}</pre>}
          {form.fields.map(field => {
            const fieldId = `gateway-interaction-${item.interaction_id}-${field.id}`
            const value = current[field.id]
            return <div key={field.id} className="gateway-share-interaction-field">
              {(field.type !== 'multiple' || field.options.length === 0)
                && <label htmlFor={fieldId}>{field.title}</label>}
              {field.description && <p>{field.description}</p>}
              {field.type === 'boolean' ? <input id={fieldId} type="checkbox"
                checked={value === true}
                onChange={event => updateValue(item.interaction_id, field.id, event.target.checked)} />
                : field.type === 'multiple' && field.options.length === 0 ? <input
                  id={fieldId} type="text" placeholder="多个值用逗号分隔"
                  value={Array.isArray(value) ? value.join(', ') : ''}
                  onChange={event => updateValue(item.interaction_id, field.id,
                    event.target.value.split(',').map(entry => entry.trim()).filter(Boolean))} />
                : field.type === 'multiple' ? <fieldset id={fieldId}>
                  <legend>{field.title}</legend>
                  {field.options.map(option => <label key={option.value}>
                    <input type="checkbox" checked={Array.isArray(value) && value.includes(option.value)}
                      onChange={event => {
                        const selected = Array.isArray(value) ? value : []
                        updateValue(item.interaction_id, field.id, event.target.checked
                          ? [...selected, option.value] : selected.filter(entry => entry !== option.value))
                      }} />{option.label}
                  </label>)}
                </fieldset> : field.type === 'number' ? <input id={fieldId} type="number"
                  value={typeof value === 'number' ? value : ''}
                  onChange={event => updateValue(item.interaction_id, field.id,
                    event.target.value === '' ? '' : Number(event.target.value))} />
                : field.options.length > 0 && !field.allowInput ? <select id={fieldId}
                  value={typeof value === 'string' ? value : ''}
                  onChange={event => updateValue(item.interaction_id, field.id, event.target.value)}>
                  <option value="">请选择</option>
                  {field.options.map(option => <option key={option.value} value={option.value}>
                    {option.label}
                  </option>)}
                </select> : <input id={fieldId} type="text"
                  value={typeof value === 'string' ? value : ''}
                  onChange={event => updateValue(item.interaction_id, field.id, event.target.value)} />}
            </div>
          })}
          <div className="gateway-share-step-actions">
            <button type="button" disabled={!complete || busy || !csrf}
              onClick={() => setConfirm({ item,
                data: buildInteractionResponse(item.request, current) })}>提交回复</button>
            <button type="button" disabled={busy || !csrf}
              onClick={() => setConfirm({ item,
                data: cancelInteractionResponse(item.request) })}>取消请求</button>
          </div>
        </article>
      })}
      <button type="button" disabled={busy} onClick={() => void load()}>刷新交互</button>
    </>}
    {confirm && <GatewayConfirmDialog title="确认引擎回复"
      message={`向步骤 ${confirm.item.step_key} 提交“${interactionForm(confirm.item.request).title}”的回复？`}
      confirmLabel="确认提交" busy={busy}
      onConfirm={() => void submit()} onCancel={() => setConfirm(null)} />}
  </section>
}
