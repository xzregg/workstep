import { PasswordConfirmation, confirmStepUp, PasswordConfirmationRequired } from './PasswordConfirmation'
import { useContext, useEffect, useState } from 'react'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'

type BillForm = { providerId: string; lineId: string; model: string; day: string;
  inputTokens: string; outputTokens: string; currency: string; billedCost: string;
  password: string }
const emptyForm: BillForm = { providerId: '', lineId: '', model: '', day: '',
  inputTokens: '', outputTokens: '', currency: 'USD', billedCost: '', password: '' }

export function AdminUsageBillImport() {
  const passwordRequired = useContext(PasswordConfirmationRequired)
  const [open, setOpen] = useState(false)
  const [csrf, setCsrf] = useState('')
  const [form, setForm] = useState<BillForm>(emptyForm)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState('')
  const [discard, setDiscard] = useState(false)

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    void fetch('/api/auth/session', { credentials: 'same-origin', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('管理员会话读取失败。')
        const data = await response.json()
        if (!controller.signal.aborted) setCsrf(data.csrf_token ?? '')
      }).catch(reason => {
        if (reason?.name !== 'AbortError') setError('管理员会话读取失败。')
      })
    return () => controller.abort()
  }, [open])

  function update(field: keyof BillForm, value: string) {
    setForm(current => ({ ...current, [field]: value }))
  }

  async function submit() {
    const input = Number(form.inputTokens)
    const output = Number(form.outputTokens)
    if (!Number.isSafeInteger(input) || input < 0 || !Number.isSafeInteger(output) || output < 0
        || !/^\d+(?:\.\d{1,6})?$/.test(form.billedCost)
        || !/^[A-Z]{3}$/.test(form.currency)) {
      setError('Token、金额或币种格式无效。'); return
    }
    setBusy(true); setError(''); setResult('')
    const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }
    try {
      const step = await confirmStepUp(csrf, form.password, passwordRequired)
      if (!step.ok) throw new Error('管理员密码验证失败。')
      const response = await fetch('/api/admin/usage/provider-bills', { method: 'POST',
        credentials: 'same-origin', headers, body: JSON.stringify({
          batch_id: form.lineId.trim(), lines: [{
            line_id: form.lineId.trim(), provider_id: form.providerId.trim(),
            model: form.model.trim(), day: form.day, input_tokens: input,
            output_tokens: output, currency: form.currency,
            billed_cost: form.billedCost,
          }],
        }) })
      if (!response.ok) throw new Error(response.status === 409
        ? '该供应商账单行 ID 已存在，但内容不同。' : '账单行导入失败。')
      const data = await response.json()
      setResult(`已导入 ${(data.accepted ?? []).length} 条账单行，重复 ${(data.duplicates ?? []).length} 条。请查看账单差异。`)
      setForm(emptyForm)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '账单行导入失败。')
    } finally { setBusy(false) }
  }

  const required = form.providerId.trim() && form.lineId.trim() && form.model.trim()
    && form.day && form.inputTokens && form.outputTokens && form.billedCost && (!passwordRequired || form.password)
  const dirty = Object.entries(form).some(([key, value]) =>
    key !== 'currency' && Boolean(value))
  return <>
    <button type="button" onClick={() => { setCsrf(''); setError(''); setResult(''); setOpen(true) }}>
      导入供应商账单</button>
    {open && <GatewayConfirmDialog title="导入供应商账单"
      message="录入已核对的供应商账单行。同一供应商账单行 ID 重复导入时内容必须一致。"
      confirmLabel="导入账单行" busy={busy} disabled={!csrf || !required}
      onConfirm={() => void submit()} onCancel={() => dirty && !result
        ? setDiscard(true) : setOpen(false)}>
      <div className="gateway-usage-filters">
        <label>供应商 ID<input value={form.providerId} maxLength={64}
          onChange={event => update('providerId', event.target.value)} /></label>
        <label>账单行 ID<input value={form.lineId} maxLength={128}
          onChange={event => update('lineId', event.target.value)} /></label>
        <label>模型<input value={form.model} maxLength={128}
          onChange={event => update('model', event.target.value)} /></label>
        <label>UTC 日期<input type="date" max={new Date().toISOString().slice(0, 10)}
          value={form.day} onChange={event => update('day', event.target.value)} /></label>
        <label>输入 Token<input type="number" min="0" value={form.inputTokens}
          onChange={event => update('inputTokens', event.target.value)} /></label>
        <label>输出 Token<input type="number" min="0" value={form.outputTokens}
          onChange={event => update('outputTokens', event.target.value)} /></label>
        <label>币种<input value={form.currency} maxLength={3}
          onChange={event => update('currency', event.target.value.toUpperCase())} /></label>
        <label>账单金额<input inputMode="decimal" value={form.billedCost}
          onChange={event => update('billedCost', event.target.value)} /></label>
        <PasswordConfirmation label="管理员密码" value={form.password} onChange={value => update('password', value)} />
      </div>
      {busy && <p role="status"><span className="gateway-spinner" aria-hidden="true" /> 正在导入账单行…</p>}
      {error && <p role="alert" className="gateway-auth-error">{error}</p>}
      {result && <p role="status">{result}</p>}
    </GatewayConfirmDialog>}
    {discard && <GatewayConfirmDialog title="放弃账单导入" message="已填写的账单字段将被清除。"
      confirmLabel="放弃并关闭" onConfirm={() => {
        setOpen(false); setDiscard(false); setForm(emptyForm)
      }} onCancel={() => setDiscard(false)} />}
  </>
}
