import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'

type Target = { id: string; name: string; version: string; online: boolean }
type Command = { id: string; device_id: string; status: string; error: string | null; expires_at: string }
type Batch = { id: string; action: string; engine_id: string; version: string | null;
  max_concurrency: number; status: string; created_at: string; commands: Command[] }

const actionNames: Record<string, string> = {
  install: '安装', update: '升级', rollback: '回退', refresh: '重新扫描', test: '测试',
}
const statusNames: Record<string, string> = {
  queued: '排队', sent: '已下发', received: '已接收', running: '执行中',
  succeeded: '成功', failed: '失败', expired: '过期',
}

function OperationCreate({ csrf, onCreated }: { csrf: string; onCreated: () => void }) {
  const [targets, setTargets] = useState<Target[]>([])
  const [chosen, setChosen] = useState<Record<string, Target>>({})
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [action, setAction] = useState('install')
  const [engineId, setEngineId] = useState('')
  const [version, setVersion] = useState('')
  const [concurrency, setConcurrency] = useState(1)
  const [termsAccepted, setTermsAccepted] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    void fetch(`/api/admin/devices?status=active&sort=name&direction=asc&page=${page}&page_size=25`, {
      credentials: 'same-origin', signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error('可选设备加载失败。')
      const data = await response.json()
      if (!controller.signal.aborted) { setTargets(data.devices ?? []); setTotal(data.total ?? 0) }
    }).catch(reason => {
      if (reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : '可选设备加载失败。')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [page, revision])

  const selected = Object.values(chosen)
  const needsVersion = action === 'install' || action === 'update'
  const validEngine = /^[a-z][a-z0-9_]*$/.test(engineId)
  const validVersion = /^[0-9][0-9A-Za-z.+-]*$/.test(version)
  const canCreate = selected.length > 0 && selected.length <= 100 && validEngine &&
    (!needsVersion || validVersion) && concurrency >= 1 && concurrency <= 32 &&
    (action !== 'install' && action !== 'update' || termsAccepted)

  async function create() {
    setBusy(true); setError('')
    try {
      const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }
      const step = await fetch('/api/auth/step-up', { method: 'POST', credentials: 'same-origin', headers,
        body: JSON.stringify({ password }) })
      if (!step.ok) throw new Error('密码验证失败。')
      const response = await fetch('/api/admin/device-operations', { method: 'POST', credentials: 'same-origin', headers,
        body: JSON.stringify({ action, engine_id: engineId, version: needsVersion ? version : null,
          device_ids: selected.map(target => target.id), max_concurrency: concurrency,
          accept_third_party_terms: termsAccepted }) })
      if (!response.ok) throw new Error('批量作业创建失败，请检查设备状态和参数。')
      setConfirming(false); setPassword(''); setChosen({}); onCreated()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '批量作业创建失败。') }
    finally { setBusy(false) }
  }

  return <section className="gateway-overview-card gateway-operation-create">
    <h3>创建批量作业</h3>
    <p>选择的设备会在确认时固定；后续筛选变化不会改变作业目标。最多 100 台。</p>
    <div className="gateway-admin-filters">
      <label htmlFor="operation-action">操作</label><select id="operation-action" value={action}
        onChange={event => setAction(event.target.value)}>{Object.entries(actionNames).map(([value, label]) =>
          <option key={value} value={value}>{label}</option>)}</select>
      <label htmlFor="operation-engine">引擎 ID</label><input id="operation-engine" value={engineId}
        onChange={event => setEngineId(event.target.value)} placeholder="例如 codex" />
      {needsVersion && <><label htmlFor="operation-version">确切版本</label><input id="operation-version"
        value={version} onChange={event => setVersion(event.target.value)} placeholder="例如 1.2.3" /></>}
      <label htmlFor="operation-concurrency">并发数</label><input id="operation-concurrency" type="number"
        min="1" max="32" value={concurrency} onChange={event => setConcurrency(Number(event.target.value))} />
    </div>
    <p>已选 {selected.length} 台 · 预计下载量：暂无法估算，由目标 PC 的引擎安装器决定。</p>
    <label className="gateway-operation-checkbox"><input type="checkbox" checked={termsAccepted}
      onChange={event => setTermsAccepted(event.target.checked)} /> 已在引擎发行方查看并接受第三方安装条款</label>
    {loading && <p role="status">正在加载可选设备…</p>}
    <ul className="gateway-device-list">{targets.map(target => <li key={target.id}>
      <label className="gateway-operation-checkbox"><input type="checkbox" checked={!!chosen[target.id]}
        onChange={event => setChosen(current => {
          const next = { ...current }
          if (event.target.checked) next[target.id] = target
          else delete next[target.id]
          return next
        })} /> {target.name}（{target.id}）· {target.online ? '在线' : '离线'}</label>
    </li>)}</ul>
    <div className="gateway-admin-pagination"><span>共 {total} 台有效设备 · 第 {page}/{Math.max(1, Math.ceil(total / 25))} 页</span>
      <button type="button" disabled={page <= 1 || loading} onClick={() => setPage(value => value - 1)}>上一页</button>
      <button type="button" disabled={page >= Math.ceil(total / 25) || loading}
        onClick={() => setPage(value => value + 1)}>下一页</button></div>
    <button type="button" disabled={!canCreate || loading} onClick={() => { setError(''); setConfirming(true) }}>核对并创建作业</button>
    {error && <p role="alert" className="gateway-auth-error">{error} {!confirming &&
      <button type="button" onClick={() => setRevision(value => value + 1)}>重试加载</button>}</p>}
    {confirming && <GatewayConfirmDialog title="确认批量作业" message={`目标 ${selected.length} 台 · ${actionNames[action]} ${engineId}${needsVersion ? ` ${version}` : ''} · 并发 ${concurrency} 台 · 预计下载量暂无法估算。确认后目标不会随筛选变化。`}
      confirmLabel="创建作业" busy={busy} disabled={!password} onConfirm={() => void create()}
      onCancel={() => { setConfirming(false); setPassword('') }}>
      <p>第三方安装条款：{termsAccepted ? '已确认' : '未确认'}。目标：{selected.map(target => target.name).join('、')}</p>
      <label htmlFor="operation-password">输入管理员密码确认</label>
      <input id="operation-password" type="password" autoComplete="current-password" value={password}
        onChange={event => setPassword(event.target.value)} />
      {error && <p role="alert" className="gateway-auth-error">{error}</p>}
    </GatewayConfirmDialog>}
  </section>
}

function OperationHistory({ csrf, revision }: { csrf: string; revision: number }) {
  const [batches, setBatches] = useState<Batch[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [refresh, setRefresh] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState<Batch | null>(null)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    void fetch(`/api/admin/device-operations?limit=25&offset=${(page - 1) * 25}`, {
      credentials: 'same-origin', signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error('批量作业加载失败。')
      const data = await response.json()
      if (!controller.signal.aborted) { setBatches(data.batches ?? []); setTotal(data.total ?? 0) }
    }).catch(reason => {
      if (reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : '批量作业加载失败。')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [page, refresh, revision])

  async function retryFailed(batch: Batch) {
    setBusy(true); setError('')
    try {
      const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }
      const step = await fetch('/api/auth/step-up', { method: 'POST', credentials: 'same-origin', headers,
        body: JSON.stringify({ password }) })
      if (!step.ok) throw new Error('密码验证失败。')
      const response = await fetch(`/api/admin/device-operations/${encodeURIComponent(batch.id)}/retry-failed`, {
        method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf },
      })
      if (!response.ok) throw new Error('重试失败项未能创建，请刷新状态后重试。')
      setRetry(null); setPassword(''); setPage(1); setRefresh(value => value + 1)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '重试失败。') }
    finally { setBusy(false) }
  }

  return <section className="gateway-overview-card gateway-operation-history">
    <div className="gateway-admin-toolbar"><h3>作业记录</h3><button type="button" disabled={loading}
      onClick={() => setRefresh(value => value + 1)}>刷新状态</button></div>
    {loading && <p role="status">正在加载作业…</p>}
    {error && <p role="alert" className="gateway-auth-error">{error} {!retry &&
      <button type="button" onClick={() => setRefresh(value => value + 1)}>重试</button>}</p>}
    {!loading && !error && batches.length === 0 && <p>暂无批量作业。</p>}
    <ul className="gateway-operation-list">{batches.map(batch => <li key={batch.id}>
      <div className="gateway-admin-toolbar"><strong>{actionNames[batch.action] ?? batch.action} · {batch.engine_id} {
        batch.version ?? ''}</strong><span>{batch.status === 'finished' ? '已结束' : batch.status === 'queued' ? '排队' : '运行中'} · {batch.commands.length} 台</span></div>
      <p>创建时间：{new Date(batch.created_at).toLocaleString()} · 并发 {batch.max_concurrency}</p>
      <ul>{batch.commands.map(command => <li key={command.id}>{command.device_id} · {
        statusNames[command.status] ?? command.status}{command.error ? ` · ${command.error}` : ''}</li>)}</ul>
      {batch.commands.some(command => command.status === 'failed' || command.status === 'expired') &&
        <button type="button" onClick={() => { setError(''); setRetry(batch) }}>只重试失败项</button>}
    </li>)}</ul>
    <div className="gateway-admin-pagination"><span>共 {total} 个作业 · 第 {page}/{Math.max(1, Math.ceil(total / 25))} 页</span>
      <button type="button" disabled={page <= 1 || loading} onClick={() => setPage(value => value - 1)}>上一页</button>
      <button type="button" disabled={page >= Math.ceil(total / 25) || loading}
        onClick={() => setPage(value => value + 1)}>下一页</button></div>
    {retry && <GatewayConfirmDialog title="重试失败设备" message={`只为作业 ${retry.id} 中失败或过期的设备创建新作业，共 ${retry.commands.filter(command => command.status === 'failed' || command.status === 'expired').length} 台。`}
      confirmLabel="创建重试作业" busy={busy} disabled={!password} onConfirm={() => void retryFailed(retry)}
      onCancel={() => { setRetry(null); setPassword('') }}>
      <label htmlFor="retry-operation-password">输入管理员密码确认</label>
      <input id="retry-operation-password" type="password" autoComplete="current-password" value={password}
        onChange={event => setPassword(event.target.value)} />
      {error && <p role="alert" className="gateway-auth-error">{error}</p>}
    </GatewayConfirmDialog>}
  </section>
}

export function AdminDeviceOperationsPage() {
  const [csrf, setCsrf] = useState('')
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/auth/session', { credentials: 'same-origin', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('登录状态已失效，请重新登录。')
        const data = await response.json()
        if (!controller.signal.aborted) setCsrf(data.csrf_token)
      }).catch(reason => {
        if (reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : '登录状态加载失败。')
      })
    return () => controller.abort()
  }, [])
  return <section className="gateway-admin-page">
    <span className="gateway-auth-eyebrow">WORKSTEP GATEWAY · ADMIN</span>
    <div className="gateway-admin-toolbar"><h2>设备批量作业</h2><Link to="/admin/devices">返回设备管理</Link></div>
    {!csrf && !error && <p role="status">正在检查登录状态…</p>}
    {error && <p role="alert" className="gateway-auth-error">{error}</p>}
    {csrf && <><OperationCreate csrf={csrf} onCreated={() => setRevision(value => value + 1)} />
      <OperationHistory csrf={csrf} revision={revision} /></>}
  </section>
}
