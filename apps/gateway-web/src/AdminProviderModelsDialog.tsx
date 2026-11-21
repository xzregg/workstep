import { localizeGatewayError } from './gatewayErrorText'
import { useId, useState } from 'react'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'
import { PasswordConfirmation, confirmStepUp, type useStepUpPassword } from './PasswordConfirmation'

type Provider = { id: string; name: string; revision: number }
type Preview = { revision: number; models: { id: string }[]; errors: { protocol: string; error: string }[] }

export function AdminProviderModelsDialog({ provider, initialModels, csrf, authorization, onClose, onApply }: {
  provider: Provider; initialModels: string[]; csrf: string; authorization: ReturnType<typeof useStepUpPassword>;
  onClose: () => void; onApply: (models: string[]) => void
}) {
  const [models, setModels] = useState(() => [...new Set(initialModels)])
  const [selected, setSelected] = useState(() => [...new Set(initialModels)])
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])
  const [conflict, setConflict] = useState(false)
  const [discard, setDiscard] = useState(false)
  const { password, setPassword, passwordRequired, passwordReady } = authorization
  const passwordId = useId()
  const dirty = JSON.stringify([...selected].sort()) !== JSON.stringify([...initialModels].sort())
  const filtered = models.filter(model => model.toLowerCase().includes(query.toLowerCase()))

  async function fetchModels() {
    if (busy || conflict) return
    if (!passwordReady) {
      setError('Please enter the administrator password, then retrieve the model.')
      document.getElementById(passwordId)?.focus()
      return
    }
    setBusy(true); setError(''); setWarnings([])
    try {
      const step = await confirmStepUp(csrf, password, passwordRequired)
      if (!step.ok) throw Error('Password verification failed.')
      const response = await fetch(`/api/admin/providers/${encodeURIComponent(provider.id)}/models/preview`, {
        method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf },
      })
      if (response.status === 409) {
        setConflict(true)
        throw Error('Supplier configuration has changed. Please reopen the supplier editing page.')
      }
      if (!response.ok) throw Error('Failed to get the model. Please check the configuration and try again.')
      const preview = await response.json() as Preview
      if (preview.revision !== provider.revision) {
        setConflict(true)
        throw Error('Supplier configuration has changed. Please reopen the supplier editing page.')
      }
      const found = preview.models.map(model => model.id)
      setModels([...new Set([...initialModels, ...selected, ...found])].sort())
      if (found.length) setQuery('')
      setWarnings(preview.errors.map(item => `${item.protocol}：${item.error}`))
      if (!found.length && !preview.errors.length) setWarnings(['供应商未返回模型。可在编辑供应商中手动填写允许模型。'])
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Operation failed, please try again.') }
    finally { setBusy(false) }
  }

  return <>
    <GatewayConfirmDialog title={`${provider.name} · 获取模型`} className="gateway-provider-models"
      message="网关使用已保存的连接获取模型。勾选后应用到编辑表单，保存供应商后下发到 PC。"
      confirmLabel={`应用到表单（${selected.length}）`} busy={busy}
      disabled={conflict || !dirty || selected.length > 1000}
      onConfirm={() => onApply(selected)} onCancel={() => dirty ? setDiscard(true) : onClose()}>
      {passwordRequired && <div className="gateway-provider-models-password">
        <PasswordConfirmation id={passwordId} label="输入管理员密码确认" value={password} disabled={busy}
          onChange={value => { setPassword(value); setError('') }} />
      </div>}
      <div className="gateway-provider-models-toolbar">
        <label htmlFor="gateway-provider-model-search">搜索模型
          <input id="gateway-provider-model-search" type="search" autoComplete="off" value={query}
            onChange={event => setQuery(event.target.value)} />
        </label>
        <div className="gateway-provider-models-toolbar-actions">
          <button type="button" disabled={busy || conflict} onClick={() => void fetchModels()}>获取模型</button>
          <button type="button" disabled={busy || conflict || filtered.length === 0} onClick={() => {
            const all = filtered.every(model => selected.includes(model))
            setSelected(all ? selected.filter(model => !filtered.includes(model)) : [...new Set([...selected, ...filtered])])
          }}>{filtered.length > 0 && filtered.every(model => selected.includes(model)) ? '取消全选' : '全选'}</button>
        </div>
      </div>
      {busy && <p role="status"><span className="gateway-spinner" aria-hidden="true" /> 正在获取模型…</p>}
      {error && <p role="alert" className="gateway-auth-error">{localizeGatewayError(error)}</p>}
      {warnings.map(warning => <p role="status" key={warning}>{warning}</p>)}
      <div className="gateway-provider-models-list" aria-label="允许下发的模型">
        {filtered.map(model => <label key={model}>
          <input type="checkbox" checked={selected.includes(model)} disabled={busy || conflict}
            onChange={event => setSelected(current => event.target.checked ? [...current, model] : current.filter(id => id !== model))} />
          <span>{model}</span>
        </label>)}
        {!filtered.length && !busy && (models.length ? <p>没有匹配的模型。 <button type="button"
          onClick={() => setQuery('')}>清除搜索</button></p> : <p>点击获取模型，或返回编辑表单手动填写。</p>)}
      </div>
      <p>已选 {selected.length} 个模型{selected.length > 1000 ? '，最多可下发 1000 个。' : '。'}</p>
    </GatewayConfirmDialog>
    {discard && <GatewayConfirmDialog title="放弃模型修改" message="当前模型选择尚未保存。" confirmLabel="放弃并关闭"
      onConfirm={onClose} onCancel={() => setDiscard(false)} />}
  </>
}
