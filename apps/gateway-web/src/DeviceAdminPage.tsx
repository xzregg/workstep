import { localizeGatewayError } from './gatewayErrorText'
import Select from './GatewaySelect'
import { useSearchParams } from 'react-router-dom'
import { DeviceHealthDetails } from './DeviceHealthDetails'
import { AdminRowMenu } from './AdminRowMenu'
import { AdminRecordDetails } from './AdminRecordDetails'
import { AdminListStatus } from './AdminListStatus'
import { AdminManagementDialog } from './AdminManagementDialog'
import { AdminDeviceOwnerDialog } from './AdminDeviceOwnerDialog'
import { AdminRecordTable } from './AdminRecordTable'
import { useEffect, useState } from 'react'
import { AdminAccessGrants } from './AdminAccessGrants'
import { GatewayLoginForm } from './GatewayLoginForm'
import { AdminDeviceActionDialog } from './AdminDeviceActionDialog'
import { AdminDeviceNameDialog } from './AdminDeviceNameDialog'
import type { AdminDevice, DeviceAction, WebRtcAdminDevice } from './AdminDeviceActionDialog'

type DeviceFilters = { health?: string; status: string; q: string; sort: string; direction: string; page: number; pageSize: number }
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
  if (filters.health) params.set('health', filters.health)
  if (filters.status) params.set('status', filters.status)
  if (filters.q.trim()) params.set('q', filters.q.trim())
  return params.toString()
}

export function DeviceAdminPage() {
  const [params] = useSearchParams()
  const linkedStatus = ['pending','active','disabled','revoked'].includes(params.get('status') ?? '') ? params.get('status')! : ''
  const linkedHealth = params.get('health') === 'unhealthy' ? 'unhealthy' : ''
  const [status, setStatus] = useState<'checking' | 'login' | 'ready' | 'session-error'>('checking')
  const [sessionRevision, setSessionRevision] = useState(0)
  const [csrf, setCsrf] = useState('')
  const [devices, setDevices] = useState<AdminDevice[]>([])
  const [webRtcDevices, setWebRtcDevices] = useState<WebRtcAdminDevice[]>([])
  const [filters, setFilters] = useState<DeviceFilters>({ health: linkedHealth, status: linkedStatus, q: '', sort: 'created_at',
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
    setFilters(current => current.status === linkedStatus && current.health === linkedHealth ? current
      : { ...current, status: linkedStatus, health: linkedHealth, page: 1 })
  }, [linkedStatus, linkedHealth])

  useEffect(() => {
    const controller = new AbortController()
    setStatus('checking'); setError('')
    void fetch('/api/auth/session', { credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        if (controller.signal.aborted) return
        if (response.status === 401) { setStatus('login'); return }
        if (!response.ok) throw new Error('Could not load your session. Try again.')
        const result = await response.json()
        if (controller.signal.aborted) return
        setCsrf(result.csrf_token)
        setStatus('ready')
      })
      .catch(() => { if (!controller.signal.aborted) { setStatus('session-error'); setError('Could not load your session. Try again.') } })
    return () => controller.abort()
  }, [sessionRevision])

  useEffect(() => {
    if (status !== 'ready') return
    const controller = new AbortController()
    setLoading(true); setError(''); setDevices([]); setWebRtcDevices([]); setTotal(0)
    void fetch(`/api/admin/devices?${buildDeviceListQuery(filters)}`, {
      credentials: 'same-origin', signal: controller.signal,
    }).then(async response => {
      if (controller.signal.aborted) return
      if (response.status === 401) { setCsrf(''); setWebRtcDevices([]); setStatus('login'); return }
      if (!response.ok) throw new Error(response.status === 403 ? 'The current account does not have device management permissions.' : 'Failed to load device list.')
      const result = await response.json()
      if (!controller.signal.aborted) {
        setDevices(result.devices ?? [])
        setWebRtcDevices(result.webrtc_devices ?? [])
        setTotal(result.total ?? 0)
      }
    }).catch(reason => {
      if (!controller.signal.aborted && reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : 'Failed to load device list.')
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
      if (!response.ok) throw new Error('Login failed, please check your account and password.')
      setCsrf((await response.json()).csrf_token)
      setStatus('ready')
      window.dispatchEvent(new Event('gateway-auth-changed'))
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Login failed.') }
    finally { setBusy(false) }
  }

  return <section className="gateway-admin-page">
    <span className="gateway-auth-eyebrow">WORKSTEP 平台</span>
    <div className="gateway-admin-toolbar"><h2>设备管理</h2></div>
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
      <Select id="device-filter" value={filters.status} onChange={event => setFilters(current => (
        { ...current, status: event.target.value, page: 1 }))}>
        <option value="pending">待审批</option><option value="active">已启用</option>
        <option value="disabled">已停用</option><option value="revoked">已撤销</option><option value="">全部</option>
      </Select>
      <label htmlFor="device-health">服务健康</label>
      <Select id="device-health" value={filters.health ?? ''} onChange={event => setFilters(current => ({ ...current, health: event.target.value, page: 1 }))}>
        <option value="">全部</option><option value="unhealthy">异常设备</option>
      </Select>
      <label htmlFor="device-sort">排序</label>
      <Select id="device-sort" value={filters.sort} onChange={event => setFilters(current => (
        { ...current, sort: event.target.value, page: 1 }))}>
        <option value="created_at">注册时间</option><option value="name">电脑名称</option><option value="status">状态</option>
      </Select>
      <Select aria-label="排序方向" value={filters.direction} onChange={event => setFilters(current => (
        { ...current, direction: event.target.value, page: 1 }))}>
        <option value="desc">降序</option><option value="asc">升序</option>
      </Select>
      </div>
      <AdminListStatus loading={loading} label="正在加载设备…"/>
      <AdminRecordTable busy={loading} columns={['设备名称','连接状态','所有者','连接 IP','daemon 版本','升级检查','操作']}>
        {devices.map(device => <tr key={device.id}>
          <td><button type="button" className="gateway-device-name-button" disabled={loading || !csrf}
            aria-label={`修改设备名称：${device.name?.trim() || '未命名设备'}`} title="点击修改设备名称"
            onClick={() => setRenameDevice(device)}>{device.name?.trim() || '未命名设备'}</button><small className="gateway-admin-cell-meta">{deviceStatusLabel[device.status] ?? device.status}</small></td>
          <td><span className={device.online ? 'gateway-device-presence gateway-device-presence--online' : 'gateway-device-presence'}>{device.online ? '在线' : '离线'}</span><small className="gateway-admin-cell-meta">健康：{device.daemon_health === true ? '正常' : device.daemon_health === false ? '异常' : '未知'}</small>{device.webrtc_online && <small className="gateway-admin-cell-meta gateway-webrtc-inline-meta">WebRTC P2P 在线</small>}</td>
          <td>{device.owner_name ?? '未确定'}</td><td>{device.connection_ip ?? '—'}</td><td>{device.version || '未上报'}</td>
          <td>{device.update_available === true ? `有新版本 ${device.latest_version}` : device.update_available === false ? '已是最新' : '暂无发布版本'}</td>
          <td><div className="gateway-row-actions">
            <AdminRecordDetails title={`${deviceDisplayName(device)} · 设备详情`}><dl className="gateway-admin-details">
              <div><dt>设备 ID</dt><dd>{device.id}</dd></div><div><dt>所有者 ID</dt><dd>{device.owner_user_id ?? '未确定'}</dd></div>
              <div><dt>连接 IP</dt><dd>{device.connection_ip ?? (device.online ? '未知' : '离线，暂无连接 IP')}</dd></div>
              <div><dt>daemon 版本</dt><dd>{device.version || '未上报'}</dd></div>
              <div><dt>升级检查</dt><dd>{device.update_available == null ? '暂无对应发布版本，无法比较' : device.update_available ? `有新版本 ${device.latest_version}` : '已是最新'}</dd></div>
              {device.webrtc_p2p_path && <div><dt>WebRTC 接入地址</dt><dd>{device.webrtc_p2p_path}</dd></div>}
            </dl><DeviceHealthDetails device={device} />{device.status === 'revoked' && <p>该设备身份已撤销，不能直接重新启用。需要重新接入时，可彻底删除后再次登录登记。</p>}</AdminRecordDetails>
            <AdminRowMenu label={`${deviceDisplayName(device)} · 更多操作`}>
            <button type="button" disabled={loading} onClick={() => setRenameDevice(device)}>修改名称</button>
            <button type="button" disabled={loading || device.status === 'revoked'} onClick={() => setOwnerDevice(device)}>转移所有者</button>
            <button type="button" disabled={loading || device.status !== 'active'} onClick={() => setGrantDevice(device)}>管理授权</button>
            <button type="button" disabled={loading || !['pending','disabled'].includes(device.status)} onClick={() => setSelected({device,action:device.status === 'pending' ? 'approve' : 'enable'})}>{device.status === 'pending' ? '批准' : '重新启用'}</button>
            <button type="button" className="gateway-admin-danger" disabled={loading || device.status !== 'active'} onClick={() => setSelected({device,action:'disable'})}>停用</button>
            <button type="button" className="gateway-admin-danger" disabled={loading || device.status === 'revoked'} onClick={() => setSelected({device,action:'revoke'})}>撤销</button>
            <button type="button" className="gateway-admin-danger" disabled={loading} onClick={() => setSelected({device,action:'delete'})}>彻底删除</button>
            </AdminRowMenu>
          </div></td>
        </tr>)}
      </AdminRecordTable>
      {!loading && !error && devices.length === 0 && <p>当前筛选下没有设备。</p>}
      <div className="gateway-admin-pagination">
        <span>共 {total} 台设备 · 第 {filters.page}/{Math.max(1, Math.ceil(total / filters.pageSize))} 页</span>
        <button type="button" disabled={filters.page <= 1 || loading} onClick={() => setFilters(current => (
          { ...current, page: current.page - 1 }))}>上一页</button>
        <button type="button" disabled={filters.page >= Math.ceil(total / filters.pageSize) || loading} onClick={() => setFilters(current => (
          { ...current, page: current.page + 1 }))}>下一页</button>
      </div>
      <section className="gateway-webrtc-devices-section" aria-labelledby="webrtc-devices-heading">
        <div className="gateway-webrtc-devices-header">
          <h3 id="webrtc-devices-heading">WebRTC 直连设备</h3>
          <span>共 {webRtcDevices.length} 台在线</span>
        </div>
        {webRtcDevices.length === 0 ? (
          !loading && !error && <p className="gateway-webrtc-empty">当前没有在线的 WebRTC 注册设备。</p>
        ) : (
          <AdminRecordTable busy={loading} columns={['设备名称', '信令状态', '绑定方式', '连接 IP', '接入地址', '操作']}>
            {webRtcDevices.map((item) => (
              <tr key={item.device_id}>
                <td>
                  <strong>{item.name}</strong>
                  <small className="gateway-admin-cell-meta">{item.device_id}</small>
                </td>
                <td>
                  <span className="gateway-device-presence gateway-device-presence--online">信令在线</span>
                  <small className="gateway-admin-cell-meta">会话 {item.active_sessions}</small>
                </td>
                <td>
                  {item.gateway_bound ? (item.owner_name || item.bound_device_name || '已绑定网关') : '仅信令注册'}
                  <small className="gateway-admin-cell-meta">
                    {item.gateway_bound ? '支持网关账号直连' : '需输入配对密钥'}
                  </small>
                </td>
                <td>{item.connection_ip || '—'}</td>
                <td><code className="gateway-webrtc-path">{item.p2p_path}</code></td>
                <td>
                  <div className="gateway-row-actions">
                    <AdminRecordDetails title={`${item.name} · WebRTC 详情`}>
                      <dl className="gateway-admin-details">
                        <div><dt>设备 ID</dt><dd>{item.device_id}</dd></div>
                        <div><dt>设备名称</dt><dd>{item.name}</dd></div>
                        <div><dt>连接 IP</dt><dd>{item.connection_ip || '—'}</dd></div>
                        <div><dt>接入地址</dt><dd>{item.p2p_path}</dd></div>
                        <div><dt>绑定模式</dt><dd>{item.gateway_bound ? '支持网关账号直连' : '仅信令配对'}</dd></div>
                        <div><dt>关联受管设备</dt><dd>{item.bound_device_name ? `${item.bound_device_name}（${item.bound_device_id}）` : '未绑定'}</dd></div>
                        <div><dt>所有者</dt><dd>{item.owner_name || '—'}</dd></div>
                        <div><dt>活跃会话</dt><dd>{item.active_sessions}</dd></div>
                      </dl>
                    </AdminRecordDetails>
                  </div>
                </td>
              </tr>
            ))}
          </AdminRecordTable>
        )}
      </section>
    </>}
    {grantDevice && <AdminManagementDialog title={`${grantDevice.name} · 设备授权`} onClose={() => setGrantDevice(null)}>
      <AdminAccessGrants id={grantDevice.id} name={grantDevice.name} kind="devices" csrf={csrf}
        onChanged={() => setRevision(value => value + 1)} />
    </AdminManagementDialog>}
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
    {error && <p className="gateway-auth-error" role="alert">{localizeGatewayError(error)} {(status === 'ready' || status === 'session-error') &&
      <button type="button" onClick={() => status === 'session-error' ? setSessionRevision(value => value + 1) : setRevision(value => value + 1)}>重试</button>}</p>}
  </section>
}
