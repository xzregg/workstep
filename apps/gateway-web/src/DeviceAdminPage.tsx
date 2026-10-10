import { AdminDeviceOwnerDialog } from './AdminDeviceOwnerDialog'
import { AdminRecordTable, AdminRecordRow } from './AdminRecordTable'
import { useEffect, useState } from 'react'
import { AdminAccessGrants } from './AdminAccessGrants'
import { GatewayModal } from './GatewayModal'
import { GatewayLoginForm } from './GatewayLoginForm'
import { AdminDeviceActionDialog } from './AdminDeviceActionDialog'
import { AdminDeviceNameDialog } from './AdminDeviceNameDialog'
import type { AdminDevice, DeviceAction } from './AdminDeviceActionDialog'

type DeviceFilters = { status: string; q: string; sort: string; direction: string; page: number; pageSize: number }
const deviceStatusLabel: Record<string, string> = { pending: '待审批', active: '已启用', disabled: '已停用', revoked: '已撤销' }

export function deviceDisplayName(device: { name?: string | null; connection_ip?: string | null }): string {
  const name = device.name?.trim() ?? ''
  const ip = device.connection_ip?.trim() ?? ''
  const usableName = name && !/^[0-9a-f]{12,64}$/i.test(name)
  if (!usableName) return ip || name || '未命名设备'
  return name
}

export function buildDeviceListQuery(filters: DeviceFilters): string {
  const params = new URLSearchParams({ sort: filters.sort, direction: filters.direction,
    page: String(filters.page), page_size: String(filters.pageSize) })
  if (filters.status) params.set('status', filters.status)
  if (filters.q.trim()) params.set('q', filters.q.trim())
  return params.toString()
}

export function DeviceAdminPage() {
  const [status, setStatus] = useState<'checking' | 'login' | 'ready'>('checking')
  const [csrf, setCsrf] = useState('')
  const [devices, setDevices] = useState<AdminDevice[]>([])
  const [filters, setFilters] = useState<DeviceFilters>({ status: '', q: '', sort: 'created_at',
    direction: 'desc', page: 1, pageSize: 25 })
  const [searchDraft, setSearchDraft] = useState('')
  const [total, setTotal] = useState(0)
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<{ device: AdminDevice; action: DeviceAction } | null>(null)
  const [grantDevice, setGrantDevice] = useState<AdminDevice | null>(null)
  const [ownerDevice, setOwnerDevice] = useState<AdminDevice | null>(null)
  const [renameDevice, setRenameDevice] = useState<AdminDevice | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

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
    const controller = new AbortController()
    setLoading(true); setError('')
    void fetch(`/api/admin/devices?${buildDeviceListQuery(filters)}`, {
      credentials: 'same-origin', signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error(response.status === 403 ? '当前账号没有设备管理权限。' : '设备列表加载失败。')
      const result = await response.json()
      if (!controller.signal.aborted) { setDevices(result.devices ?? []); setTotal(result.total ?? 0) }
    }).catch(reason => {
      if (reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : '设备列表加载失败。')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [status, filters, revision])

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
      window.dispatchEvent(new Event('gateway-auth-changed'))
    } catch (reason) { setError(reason instanceof Error ? reason.message : '登录失败。') }
    finally { setBusy(false) }
  }

  return <section className="gateway-admin-page">
    <span className="gateway-auth-eyebrow">WORKSTEP 平台</span>
    <div className="gateway-admin-toolbar"><h2>设备管理</h2><a href="/admin/device-operations">批量作业</a></div>
    {status === 'checking' && <p role="status">正在检查登录状态…</p>}
    {status === 'login' && <div className="gateway-admin-login">
      <p>管理员登录后可审批和管理受管电脑。</p>
      <GatewayLoginForm busy={busy} onSubmit={signIn} />
    </div>}
    {status === 'ready' && <>
      <form className="gateway-admin-search" onSubmit={event => {
        event.preventDefault(); setFilters(current => ({ ...current, q: searchDraft.trim(), page: 1 }))
      }}>
        <label htmlFor="device-search">搜索设备</label>
        <input id="device-search" value={searchDraft} onChange={event => setSearchDraft(event.target.value)} placeholder="电脑名称" />
        <button type="submit">搜索</button>
      </form>
      <div className="gateway-admin-filters">
      <button type="button" disabled={loading} onClick={() => setRevision(value => value + 1)}>刷新设备</button>
      <label htmlFor="device-filter">设备状态</label>
      <select id="device-filter" value={filters.status} onChange={event => setFilters(current => (
        { ...current, status: event.target.value, page: 1 }))}>
        <option value="pending">待审批</option><option value="active">已启用</option>
        <option value="disabled">已停用</option><option value="revoked">已撤销</option><option value="">全部</option>
      </select>
      <label htmlFor="device-sort">排序</label>
      <select id="device-sort" value={filters.sort} onChange={event => setFilters(current => (
        { ...current, sort: event.target.value, page: 1 }))}>
        <option value="created_at">注册时间</option><option value="name">电脑名称</option><option value="status">状态</option>
      </select>
      <select aria-label="排序方向" value={filters.direction} onChange={event => setFilters(current => (
        { ...current, direction: event.target.value, page: 1 }))}>
        <option value="desc">降序</option><option value="asc">升序</option>
      </select>
      </div>
      {loading && <p role="status">正在加载设备…</p>}
      <AdminRecordTable>{devices.map((device) => <AdminRecordRow key={device.id}>
        <div><strong>{deviceDisplayName(device)}</strong> <span className={device.online ? 'gateway-device-presence gateway-device-presence--online' : 'gateway-device-presence'}>{device.online ? '在线' : '离线'}</span><p>设备 ID：{device.id} · {deviceStatusLabel[device.status] ?? device.status}</p>
          <p>所有者：{device.owner_name ?? '未确定'}{device.owner_user_id ? ` · ${device.owner_user_id}` : ''}</p>
          {device.status === 'revoked' && <p>该设备身份已撤销，不能直接重新启用。需要重新接入时，可彻底删除后再次登录登记。</p>}
          <p>连接 IP：{device.connection_ip ?? (device.online ? '未知' : '离线，暂无连接 IP')}</p>
          <p>控制连接：{device.online ? '在线' : '离线'} · daemon 健康：{
            device.daemon_health === true ? '正常' : device.daemon_health === false ? '异常' : '未知'
          }</p><p>daemon 版本：{device.version || '未上报'}</p><p>升级检查：{device.update_available === true
            ? `有新版本 ${device.latest_version}`
            : device.update_available === false ? '已是最新' : '暂无对应发布版本，无法比较'}</p></div>
        <div className="gateway-device-actions">
          <button type="button" onClick={() => setRenameDevice(device)}>修改名称</button>
          {device.status !== 'revoked' && <button type="button" onClick={() => setOwnerDevice(device)}>转移所有者</button>}
          {device.status === 'active' && <button type="button" onClick={() => setGrantDevice(device)}>管理授权</button>}
          {device.status === 'pending' && <button type="button" onClick={() => setSelected({ device, action: 'approve' })}>批准</button>}
          {device.status === 'disabled' && <button type="button" onClick={() => setSelected({ device, action: 'enable' })}>重新启用</button>}
          {device.status === 'active' && <button type="button" onClick={() => setSelected({ device, action: 'disable' })}>停用</button>}
          {device.status !== 'revoked' && <button type="button" onClick={() => setSelected({ device, action: 'revoke' })}>撤销</button>}
          <button type="button" onClick={() => setSelected({ device, action: 'delete' })}>彻底删除</button>
        </div>
      </AdminRecordRow>)}</AdminRecordTable>
      {!loading && !error && devices.length === 0 && <p>当前筛选下没有设备。</p>}
      <div className="gateway-admin-pagination">
        <span>共 {total} 台设备 · 第 {filters.page}/{Math.max(1, Math.ceil(total / filters.pageSize))} 页</span>
        <button type="button" disabled={filters.page <= 1 || loading} onClick={() => setFilters(current => (
          { ...current, page: current.page - 1 }))}>上一页</button>
        <button type="button" disabled={filters.page >= Math.ceil(total / filters.pageSize) || loading} onClick={() => setFilters(current => (
          { ...current, page: current.page + 1 }))}>下一页</button>
      </div>
    </>}
    {grantDevice && <GatewayModal title={`${grantDevice.name} · 设备授权`} onClose={() => setGrantDevice(null)}
      footer={<button type="button" onClick={() => setGrantDevice(null)}>关闭</button>}>
      <AdminAccessGrants id={grantDevice.id} name={grantDevice.name} kind="devices" csrf={csrf}
        onChanged={() => setRevision(value => value + 1)} />
    </GatewayModal>}
    {selected && <AdminDeviceActionDialog device={selected.device} action={selected.action} csrf={csrf}
      onClose={() => setSelected(null)} onComplete={() => {
        setSelected(null)
        setRevision(value => value + 1)
      }} />}
    {ownerDevice && <AdminDeviceOwnerDialog device={ownerDevice} csrf={csrf}
      onClose={() => setOwnerDevice(null)} onComplete={() => {
        setOwnerDevice(null); setRevision(value => value + 1)
      }} />}
    {renameDevice && <AdminDeviceNameDialog device={renameDevice} csrf={csrf}
      onClose={() => setRenameDevice(null)} onComplete={() => {
        setRenameDevice(null); setRevision(value => value + 1)
      }} />}
    {error && <p className="gateway-auth-error" role="alert">{error} {status === 'ready' &&
      <button type="button" onClick={() => setRevision(value => value + 1)}>重试</button>}</p>}
  </section>
}
