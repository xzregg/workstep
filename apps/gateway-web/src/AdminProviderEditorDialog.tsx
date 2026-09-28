import { useState } from 'react'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'

export type ManagedProvider = { id: string; name: string; type: string; enabled: boolean;
  revision: number; protocols: string[]; protocol_base_urls: Record<string, string>;
  models: string[]; prices: { version?: string; models?: Record<string, Record<string, string>> };
  has_key: boolean }

const protocols = [
  ['anthropic_messages', 'Anthropic Messages'],
  ['openai_responses', 'OpenAI Responses'],
  ['openai_chat_completions', 'OpenAI Chat Completions'],
] as const
const priceFields = [
  ['input_per_million', '输入'], ['output_per_million', '输出'],
  ['cache_read_per_million', '缓存读取'], ['cache_write_per_million', '缓存写入'],
] as const
type PriceField = typeof priceFields[number][0]
type Prices = Record<string, Partial<Record<PriceField, string>>>

function modelsFromText(value: string) {
  return value.split(/[\n,]/).map(item => item.trim()).filter(Boolean)
}

export function AdminProviderEditorDialog({ provider, csrf, onClose, onSaved }: {
  provider?: ManagedProvider; csrf: string; onClose: () => void; onSaved: () => void
}) {
  const [name, setName] = useState(provider?.name ?? '')
  const [type, setType] = useState(provider?.type ?? 'custom')
  const [selectedProtocols, setSelectedProtocols] = useState<string[]>(provider?.protocols ?? [])
  const [urls, setUrls] = useState<Record<string, string>>(provider?.protocol_base_urls ?? {})
  const [modelsText, setModelsText] = useState(provider?.models.join('\n') ?? '')
  const [priceVersion, setPriceVersion] = useState(provider?.prices.version ?? 'v1')
  const [prices, setPrices] = useState<Prices>(provider?.prices.models ?? {})
  const [apiKey, setApiKey] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [discard, setDiscard] = useState(false)

  const models = modelsFromText(modelsText)
  const protocolUrlsValid = selectedProtocols.length > 0 && selectedProtocols.every(protocol => {
    try {
      const url = new URL(urls[protocol] ?? '')
      return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password && !url.hash
    } catch { return false }
  })
  const modelsValid = models.length <= 1000 && new Set(models).size === models.length &&
    models.every(model => model.length <= 128)
  const pricesValid = models.every(model => {
    const values = priceFields.map(([field]) => prices[model]?.[field]?.trim() ?? '')
    return values.every(value => !value) || values.every(value => value && /^\d+(?:\.\d+)?$/.test(value))
  })
  const valid = !!name.trim() && name === name.trim() && !!type.trim() && type === type.trim() &&
    !!priceVersion.trim() && protocolUrlsValid && modelsValid && pricesValid &&
    (!!provider || !!apiKey) && !!password
  const dirty = name !== (provider?.name ?? '') || type !== (provider?.type ?? 'custom') ||
    JSON.stringify(selectedProtocols) !== JSON.stringify(provider?.protocols ?? []) ||
    JSON.stringify(urls) !== JSON.stringify(provider?.protocol_base_urls ?? {}) ||
    modelsText !== (provider?.models.join('\n') ?? '') ||
    priceVersion !== (provider?.prices.version ?? 'v1') ||
    JSON.stringify(prices) !== JSON.stringify(provider?.prices.models ?? {}) || !!apiKey || !!password

  async function save() {
    if (!valid) return
    setBusy(true); setError('')
    try {
      const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }
      const step = await fetch('/api/auth/step-up', { method: 'POST', credentials: 'same-origin', headers,
        body: JSON.stringify({ password }) })
      if (!step.ok) throw new Error('密码验证失败。')
      const priced: Record<string, Record<string, string>> = {}
      for (const model of models) {
        const values = prices[model]
        if (values && priceFields.some(([field]) => values[field])) {
          priced[model] = Object.fromEntries(priceFields.map(([field]) => [field, values[field] ?? '']))
        }
      }
      const body: Record<string, unknown> = { name, type, protocols: selectedProtocols,
        protocol_base_urls: Object.fromEntries(selectedProtocols.map(protocol => [protocol, urls[protocol]])),
        models, price_version: priceVersion, prices: priced }
      if (apiKey) body.api_key = apiKey
      const response = await fetch(provider
        ? `/api/admin/providers/${encodeURIComponent(provider.id)}` : '/api/admin/providers', {
        method: provider ? 'PUT' : 'POST', credentials: 'same-origin', headers,
        body: JSON.stringify(body),
      })
      if (!response.ok) throw new Error(response.status === 409
        ? '供应商名称已存在。' : '保存供应商失败，请检查配置。')
      onSaved()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存供应商失败。') }
    finally { setBusy(false) }
  }

  return <>
    <GatewayConfirmDialog title={provider ? '编辑供应商' : '创建供应商'}
      message="配置将按授权下发到 PC，模型请求仍由 PC 直接发送给供应商。"
      className="gateway-provider-dialog"
      confirmLabel="保存供应商" busy={busy} disabled={!valid} onConfirm={() => void save()}
      onCancel={() => dirty ? setDiscard(true) : onClose()}>
      <label htmlFor="provider-name">供应商名称</label>
      <input id="provider-name" value={name} maxLength={256} onChange={event => setName(event.target.value)} />
      <label htmlFor="provider-type">供应商类型</label>
      <input id="provider-type" value={type} maxLength={64} onChange={event => setType(event.target.value)} />
      <fieldset className="gateway-provider-protocols"><legend>协议与 HTTPS 地址</legend>
        {protocols.map(([protocol, label]) => <div key={protocol}>
          <label><input type="checkbox" checked={selectedProtocols.includes(protocol)} onChange={event =>
            setSelectedProtocols(current => event.target.checked ? [...current, protocol] : current.filter(value => value !== protocol))
          } />{label}</label>
          {selectedProtocols.includes(protocol) && <input aria-label={`${label} 地址`} type="url"
            value={urls[protocol] ?? ''} onChange={event => setUrls(current => (
              { ...current, [protocol]: event.target.value }))} />}
        </div>)}</fieldset>
      <label htmlFor="provider-models">允许模型（每行一个）</label>
      <textarea id="provider-models" value={modelsText} onChange={event => setModelsText(event.target.value)} />
      <label htmlFor="provider-price-version">价格版本</label>
      <input id="provider-price-version" value={priceVersion} maxLength={64}
        onChange={event => setPriceVersion(event.target.value)} />
      {models.map(model => <fieldset className="gateway-provider-prices" key={model}>
        <legend>{model} · 每百万 Token 单价（留空表示未计价）</legend>
        {priceFields.map(([field, label]) => <label key={field}>{label}
          <input type="text" inputMode="decimal" aria-label={`${model} ${label}单价`}
            value={prices[model]?.[field] ?? ''} onChange={event => setPrices(current => ({
              ...current, [model]: { ...current[model], [field]: event.target.value },
            }))} /></label>)}</fieldset>)}
      <label htmlFor="provider-api-key">{provider ? '新凭据（留空则保留当前凭据）' : '供应商凭据'}</label>
      <input id="provider-api-key" type="password" autoComplete="new-password" value={apiKey}
        onChange={event => setApiKey(event.target.value)} />
      <label htmlFor="provider-admin-password">输入管理员密码确认</label>
      <input id="provider-admin-password" type="password" autoComplete="current-password" value={password}
        onChange={event => setPassword(event.target.value)} />
      {!protocolUrlsValid && selectedProtocols.length > 0 && <p>请填写所选协议的 HTTPS 地址。</p>}
      {!modelsValid && <p>模型名称重复或超过长度限制。</p>}
      {!pricesValid && <p>已填写单价的模型需要完整的四项非负单价。</p>}
      {error && <p role="alert" className="gateway-auth-error">{error}</p>}
    </GatewayConfirmDialog>
    {discard && <GatewayConfirmDialog title="放弃供应商修改" message="当前配置有未保存内容。"
      confirmLabel="放弃并关闭" onConfirm={onClose} onCancel={() => setDiscard(false)} />}
  </>
}

export function AdminProviderDisableDialog({ provider, csrf, onClose, onSaved }: {
  provider: ManagedProvider; csrf: string; onClose: () => void; onSaved: () => void
}) {
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function disable() {
    setBusy(true); setError('')
    try {
      const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }
      const step = await fetch('/api/auth/step-up', { method: 'POST', credentials: 'same-origin', headers,
        body: JSON.stringify({ password }) })
      if (!step.ok) throw new Error('密码验证失败。')
      const response = await fetch(`/api/admin/providers/${encodeURIComponent(provider.id)}/disable`, {
        method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf },
      })
      if (!response.ok) throw new Error('停用供应商失败。')
      onSaved()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '停用供应商失败。') }
    finally { setBusy(false) }
  }
  return <GatewayConfirmDialog title="停用供应商" message={`停用「${provider.name}」后，设备将收到新的配置版本。`}
    confirmLabel="确认停用" busy={busy} disabled={!password} onConfirm={() => void disable()} onCancel={onClose}>
    <label htmlFor="disable-provider-password">输入管理员密码确认</label>
    <input id="disable-provider-password" type="password" autoComplete="current-password" value={password}
      onChange={event => setPassword(event.target.value)} />
    {error && <p role="alert" className="gateway-auth-error">{error}</p>}
  </GatewayConfirmDialog>
}
