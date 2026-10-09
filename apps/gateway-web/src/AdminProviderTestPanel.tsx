import { PasswordConfirmation, confirmStepUp, useStepUpPassword } from './PasswordConfirmation'
import { useEffect, useState } from 'react'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'

type Target = { id: string; name: string }
type TestResult = { status: 'succeeded' | 'failed'; duration_ms: number;
  error_code: 'connection_failed' | 'provider_unavailable' | null }

const errorLabels: Record<NonNullable<TestResult['error_code']>, string> = {
  connection_failed: '连接失败', provider_unavailable: '该 PC 尚无可用配置',
}

export function AdminProviderTestPanel({ providerId, providerName, csrf, onClose }: {
  providerId: string; providerName: string; csrf: string; onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const [targets, setTargets] = useState<Target[]>([])
  const [total, setTotal] = useState(0)
  const [deviceId, setDeviceId] = useState('')
  const { password, setPassword, passwordRequired, passwordReady } = useStepUpPassword()
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState<TestResult | null>(null)
  const [discard, setDiscard] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams({ q: search, page: String(page), page_size: '25' })
    setLoading(true); setLoadError('')
    void fetch(`/api/admin/providers/${encodeURIComponent(providerId)}/test-targets?${params}`,
      { credentials: 'same-origin', signal: controller.signal }).then(async response => {
      if (!response.ok) throw new Error('在线 PC 加载失败。')
      const data = await response.json()
      if (!controller.signal.aborted) { setTargets(data.devices ?? []); setTotal(data.total ?? 0) }
    }).catch(reason => {
      if (reason?.name !== 'AbortError') setLoadError('在线 PC 加载失败。')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [providerId, search, page, revision])

  async function submit() {
    setBusy(true); setError(''); setResult(null)
    try {
      const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }
      const step = await confirmStepUp(csrf, password, passwordRequired)
      if (!step.ok) throw new Error('密码验证失败。')
      const response = await fetch(`/api/admin/providers/${encodeURIComponent(providerId)}/test`, {
        method: 'POST', credentials: 'same-origin', headers,
        body: JSON.stringify({ device_id: deviceId }),
      })
      if (!response.ok) throw new Error(response.status === 503 ? 'PC 已离线，请刷新目标列表。'
        : response.status === 504 ? '测试超时，请重试。' : '测试命令发送失败。')
      const data = await response.json()
      setResult(data as TestResult)
      setPassword('')
    } catch (reason) { setError(reason instanceof Error ? reason.message : '测试命令发送失败。') }
    finally { setBusy(false) }
  }

  const dirty = !!(deviceId || password || query)
  return <>
    <GatewayConfirmDialog title="测试供应商连接"
      message={`在目标 PC 上测试「${providerName}」连接。只返回状态和脱敏错误码。`}
      confirmLabel="发送测试命令" busy={busy} disabled={!deviceId || !passwordReady || loading || !!loadError}
      onConfirm={() => void submit()} onCancel={() => dirty ? setDiscard(true) : onClose()}>
      <form className="gateway-admin-search" onSubmit={event => {
        event.preventDefault(); setDeviceId(''); setPage(1); setSearch(query.trim())
      }}><label htmlFor="provider-test-search">搜索在线 PC</label>
        <input id="provider-test-search" value={query} onChange={event => setQuery(event.target.value)} />
        <button type="submit">搜索</button></form>
      <label htmlFor="provider-test-device">目标 PC</label>
      <select id="provider-test-device" value={deviceId} onChange={event => setDeviceId(event.target.value)}>
        <option value="">请选择</option>{targets.map(target =>
          <option key={target.id} value={target.id}>{target.name}</option>)}</select>
      <div className="gateway-admin-pagination"><span>共 {total} 台在线 PC · 第 {page}/
        {Math.max(1, Math.ceil(total / 25))} 页</span>
        <button type="button" disabled={page <= 1 || loading} onClick={() => {
          setDeviceId(''); setPage(value => value - 1)
        }}>上一页</button>
        <button type="button" disabled={page >= Math.ceil(total / 25) || loading} onClick={() => {
          setDeviceId(''); setPage(value => value + 1)
        }}>下一页</button></div>
      {loading && <p role="status">正在加载在线 PC…</p>}
      {loadError && <p role="alert" className="gateway-auth-error">{loadError} <button type="button"
        onClick={() => setRevision(value => value + 1)}>重试加载</button></p>}
      <PasswordConfirmation id="provider-test-password" label="输入管理员密码确认" value={password} onChange={setPassword} />
      {busy && <p role="status"><span className="gateway-spinner" aria-hidden="true" /> 正在测试连接…</p>}
      {error && <p role="alert" className="gateway-auth-error">{error}</p>}
      {result && <p role="status">{result.status === 'succeeded' ? '连接成功'
        : errorLabels[result.error_code ?? 'connection_failed']} · 耗时 {result.duration_ms} 毫秒</p>}
      {result && <button type="button" onClick={onClose}>关闭</button>}
    </GatewayConfirmDialog>
    {discard && <GatewayConfirmDialog title="放弃供应商测试" message="当前已选择目标 PC。"
      confirmLabel="放弃并关闭" onConfirm={onClose} onCancel={() => setDiscard(false)} />}
  </>
}
