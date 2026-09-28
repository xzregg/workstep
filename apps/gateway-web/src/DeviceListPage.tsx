import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { GatewayLoginForm } from './GatewayLoginForm'

type Device = { id: string; name: string; status: string; online: boolean; version: string }

export function DeviceListPage() {
  const [status, setStatus] = useState<'checking' | 'login' | 'ready'>('checking')
  const [devices, setDevices] = useState<Device[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function loadDevices() {
    const response = await fetch('/api/devices', { credentials: 'same-origin' })
    if (!response.ok) throw new Error('电脑列表加载失败。')
    setDevices((await response.json()).devices ?? [])
  }

  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/auth/session', { credentials: 'same-origin', signal: controller.signal })
      .then((response) => { if (!controller.signal.aborted) setStatus(response.ok ? 'ready' : 'login') })
      .catch((reason) => { if (reason?.name !== 'AbortError') setStatus('login') })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    if (status !== 'ready') return
    void loadDevices().catch((reason) => setError(reason.message))
  }, [status])

  async function signIn(username: string, password: string) {
    setBusy(true); setError('')
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      if (!response.ok) throw new Error('登录失败，请检查账号和密码。')
      setStatus('ready')
    } catch (reason) { setError(reason instanceof Error ? reason.message : '登录失败。') }
    finally { setBusy(false) }
  }

  return <section className="gateway-admin-page">
    <span className="gateway-auth-eyebrow">WORKSTEP GATEWAY</span>
    <h2>我的电脑</h2>
    {status === 'checking' && <p role="status">正在检查登录状态…</p>}
    {status === 'login' && <div className="gateway-admin-login">
      <p>登录后查看获分配的 WorkStep 电脑。</p>
      <GatewayLoginForm busy={busy} onSubmit={signIn} />
    </div>}
    {status === 'ready' && <>
      {devices.length === 0 && <div className="gateway-empty-devices">
        <p>你还没有获分配的电脑。</p>
        <Link to="/devices/empty">下载受管安装包</Link>
      </div>}
      <ul className="gateway-device-list">{devices.map((device) => <li key={device.id}>
        <div><strong>{device.name}</strong><p>{device.id} · {device.version}</p></div>
        <span className={device.online ? 'gateway-online' : 'gateway-offline'}>
          {device.online ? '在线' : '离线'}
        </span>
      </li>)}</ul>
    </>}
    {error && <p className="gateway-auth-error" role="alert">{error}</p>}
  </section>
}
