import { useEffect, useState } from 'react'
import { GatewayLoginForm } from './GatewayLoginForm'

type Device = { id: string; name: string; status: string; online: boolean; version: string; app_instance_id: string }
type Action = 'approve' | 'disable' | 'revoke'

const actionLabel: Record<Action, string> = { approve: '批准', disable: '停用', revoke: '撤销' }

export function DeviceAdminPage() {
  const [status, setStatus] = useState<'checking' | 'login' | 'ready'>('checking')
  const [csrf, setCsrf] = useState('')
  const [stepPassword, setStepPassword] = useState('')
  const [devices, setDevices] = useState<Device[]>([])
  const [filter, setFilter] = useState('pending')
  const [selected, setSelected] = useState<{ device: Device; action: Action } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function loadDevices(value: string) {
    const query = value === 'all' ? '' : `?status=${encodeURIComponent(value)}`
    const response = await fetch(`/api/admin/devices${query}`, { credentials: 'same-origin' })
    if (!response.ok) throw new Error(response.status === 403 ? '当前账号没有设备管理权限。' : '设备列表加载失败。')
    const result = await response.json()
    setDevices(result.devices ?? [])
  }

  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/auth/session', { credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) { setStatus('login'); return }
        const result = await response.json()
        if (controller.signal.aborted) return
        setCsrf(result.csrf_token)
        setStatus('ready')
      })
      .catch((reason) => { if (reason?.name !== 'AbortError') setStatus('login') })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (status !== 'ready') return
    void loadDevices(filter).catch((reason) => setError(reason.message))
  }, [status, filter])

  async function signIn(username: string, password: string) {
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      if (!response.ok) throw new Error('登录失败，请检查账号和密码。')
      setCsrf((await response.json()).csrf_token)
      setStatus('ready')
    } catch (reason) { setError(reason instanceof Error ? reason.message : '登录失败。') }
    finally { setBusy(false) }
  }

  async function applyAction() {
    if (!selected || !stepPassword) return
    setBusy(true); setError('')
    try {
      const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }
      const step = await fetch('/api/auth/step-up', {
        method: 'POST', credentials: 'same-origin', headers,
        body: JSON.stringify({ password: stepPassword }),
      })
      if (!step.ok) throw new Error('密码验证失败。')
      const response = await fetch(`/api/admin/devices/${encodeURIComponent(selected.device.id)}/${selected.action}`, {
        method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf },
      })
      if (!response.ok) throw new Error(`${actionLabel[selected.action]}设备失败。`)
      setSelected(null); setStepPassword('')
      await loadDevices(filter)
    } catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败。') }
    finally { setBusy(false) }
  }

  return <section className="gateway-admin-page">
    <span className="gateway-auth-eyebrow">WORKSTEP GATEWAY</span>
    <h2>设备管理</h2>
    {status === 'checking' && <p role="status">正在检查登录状态…</p>}
    {status === 'login' && <div className="gateway-admin-login">
      <p>管理员登录后可审批和管理受管电脑。</p>
      <GatewayLoginForm busy={busy} onSubmit={signIn} />
    </div>}
    {status === 'ready' && <>
      <label htmlFor="device-filter">设备状态</label>
      <select id="device-filter" value={filter} onChange={(event) => { setError(''); setFilter(event.target.value) }}>
        <option value="pending">待审批</option><option value="active">已启用</option>
        <option value="disabled">已停用</option><option value="revoked">已撤销</option><option value="all">全部</option>
      </select>
      <ul className="gateway-device-list">{devices.map((device) => <li key={device.id}>
        <div><strong>{device.name}</strong><p>{device.id} · {device.version} · {device.status} · {device.online ? '在线' : '离线'}</p></div>
        <div className="gateway-device-actions">
          {device.status === 'pending' && <button type="button" onClick={() => setSelected({ device, action: 'approve' })}>批准</button>}
          {device.status === 'active' && <button type="button" onClick={() => setSelected({ device, action: 'disable' })}>停用</button>}
          {device.status !== 'revoked' && <button type="button" onClick={() => setSelected({ device, action: 'revoke' })}>撤销</button>}
        </div>
      </li>)}</ul>
      {devices.length === 0 && <p>当前筛选下没有设备。</p>}
    </>}
    {selected && <div className="gateway-admin-confirm" role="dialog" aria-modal="true" aria-label="确认设备操作">
      <h3>{actionLabel[selected.action]}设备</h3>
      <p>{selected.device.name}（{selected.device.id}）</p>
      {selected.action === 'revoke' && <p>撤销后该设备必须重新注册并获批才能连接。</p>}
      <label htmlFor="admin-step-password">输入管理员密码确认</label>
      <input id="admin-step-password" type="password" autoComplete="current-password" value={stepPassword}
        onChange={(event) => setStepPassword(event.target.value)} />
      <div className="gateway-device-actions">
        <button type="button" onClick={() => { setSelected(null); setStepPassword('') }} disabled={busy}>取消</button>
        <button type="button" onClick={() => void applyAction()} disabled={busy || !stepPassword}>确认{actionLabel[selected.action]}</button>
      </div>
    </div>}
    {error && <p className="gateway-auth-error" role="alert">{error}</p>}
  </section>
}
