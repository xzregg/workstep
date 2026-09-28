import { useEffect, useState } from 'react'
import { GatewayLoginForm } from './GatewayLoginForm'
import { AdminDeviceActionDialog } from './AdminDeviceActionDialog'
import type { AdminDevice, DeviceAction } from './AdminDeviceActionDialog'

export function DeviceAdminPage() {
  const [status, setStatus] = useState<'checking' | 'login' | 'ready'>('checking')
  const [csrf, setCsrf] = useState('')
  const [devices, setDevices] = useState<AdminDevice[]>([])
  const [filter, setFilter] = useState('pending')
  const [selected, setSelected] = useState<{ device: AdminDevice; action: DeviceAction } | null>(null)
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
    {selected && <AdminDeviceActionDialog device={selected.device} action={selected.action} csrf={csrf}
      onClose={() => setSelected(null)} onComplete={() => {
        setSelected(null)
        void loadDevices(filter).catch(reason => setError(reason.message))
      }} />}
    {error && <p className="gateway-auth-error" role="alert">{error}</p>}
  </section>
}
