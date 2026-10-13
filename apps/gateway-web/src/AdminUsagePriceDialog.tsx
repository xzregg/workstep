import { useState } from 'react'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'
import { ModelPriceFields, modelPriceFields, type ModelPrices } from './ModelPriceFields'
import { PasswordConfirmation, confirmStepUp, useStepUpPassword } from './PasswordConfirmation'

export function AdminUsagePriceDialog({ models, initialPrices, csrf, onClose, onSaved }: {
  models: string[]; initialPrices?: ModelPrices; csrf: string; onClose: () => void; onSaved: (count: number) => void
}) {
  const [prices, setPrices] = useState<ModelPrices>(initialPrices ?? {})
  const { password, setPassword, passwordReady, passwordRequired } = useStepUpPassword()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [discard, setDiscard] = useState(false)
  const valid = modelPriceFields.every(([field]) => {
    const value = prices[field] ?? ''
    return /^\d+(?:\.\d{1,8})?$/.test(value) && value.length <= 32 && Number(value) <= 1000000
  })
  const dirty = JSON.stringify(prices) !== JSON.stringify(initialPrices ?? {}) || !!password
  async function save() {
    if (busy || !valid || !passwordReady) return
    setBusy(true); setError('')
    try {
      const step = await confirmStepUp(csrf,password,passwordRequired)
      if (!step.ok) throw new Error('管理员密码验证失败。')
      const response = await fetch('/api/admin/usage/model-prices', { method:'PUT', credentials:'same-origin',
        headers:{'Content-Type':'application/json','X-CSRF-Token':csrf}, body:JSON.stringify({ models, prices }) })
      if (!response.ok) throw new Error('保存模型价格失败，请重试。')
      const result = await response.json()
      onSaved(result.updated)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存模型价格失败。') }
    finally { setBusy(false) }
  }
  return <>
    <GatewayConfirmDialog title="批量设置模型价格" className="gateway-provider-dialog"
      message={`将为选中的 ${models.length} 个模型设置同一组参考价格（USD／百万 Token）。仅用于后续缺少费用的 PC 回传，历史费用不重算。`}
      confirmLabel="保存价格" busy={busy} disabled={!csrf || !valid || !passwordReady}
      onConfirm={() => void save()} onCancel={() => dirty ? setDiscard(true) : onClose()}>
      <details><summary>已选模型（{models.length}）</summary><ul>{models.map(model => <li key={model}>{model}</li>)}</ul></details>
      <fieldset className="gateway-provider-prices"><legend>每百万 Token 单价 · USD</legend>
        <ModelPriceFields values={prices} onChange={setPrices}/></fieldset>
      <p>请填写四项非负单价，0 表示免费；每项最多 8 位小数。</p>
      <PasswordConfirmation id="model-price-password" label="输入管理员密码确认" value={password} onChange={setPassword}/>
      {busy && <p role="status"><span className="gateway-spinner" aria-hidden="true"/> 正在保存价格…</p>}
      {error && <p role="alert" className="gateway-auth-error">{error}</p>}
    </GatewayConfirmDialog>
    {discard && <GatewayConfirmDialog title="放弃价格修改" message="当前价格尚未保存。"
      confirmLabel="放弃并关闭" onConfirm={onClose} onCancel={() => setDiscard(false)}/>}
  </>
}
