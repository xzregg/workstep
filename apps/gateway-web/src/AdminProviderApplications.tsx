import { useEffect, useState } from 'react'

type DeviceApplication = { device_id: string; device_name: string; device_status: string;
  online: boolean; desired_revision: number; applied_revision: number | null;
  last_error: string | null }

function applicationStatus(device: DeviceApplication) {
  if (device.device_status !== 'active') return '设备未启用'
  if (!device.online) return '离线'
  if (device.last_error) return '失败'
  if (device.applied_revision === device.desired_revision) return '已应用'
  return '等待同步'
}

export function AdminProviderApplications() {
  const [devices, setDevices] = useState<DeviceApplication[]>([])
  const [total, setTotal] = useState(0)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [revision, setRevision] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    const params = new URLSearchParams({ q: search, page: String(page), page_size: '25' })
    setLoading(true); setError('')
    void fetch(`/api/admin/providers/applications?${params}`, {
      credentials: 'same-origin', signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error('设备应用状态加载失败。')
      const data = await response.json()
      if (!controller.signal.aborted) { setDevices(data.devices ?? []); setTotal(data.total ?? 0) }
    }).catch(reason => {
      if (reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : '设备应用状态加载失败。')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [search, page, revision])

  return <section className="gateway-project-grants">
    <h3>PC 配置应用状态</h3>
    <p>版本号是整台 PC 的供应商配置包版本；状态随设备在线和应用回执更新。</p>
    <form className="gateway-admin-search" onSubmit={event => {
      event.preventDefault(); setPage(1); setSearch(query.trim())
    }}><label htmlFor="provider-device-search">搜索 PC</label>
      <input id="provider-device-search" value={query} onChange={event => setQuery(event.target.value)} />
      <button type="submit">搜索</button></form>
    {loading && <p role="status">正在加载设备状态…</p>}
    {error && <p role="alert" className="gateway-auth-error">{error} <button type="button"
      onClick={() => setRevision(value => value + 1)}>重试</button></p>}
    {!loading && !error && devices.length === 0 && <p>当前条件下没有设备。</p>}
    <ul className="gateway-device-list">{devices.map(device => <li key={device.device_id}>
      <div><strong>{device.device_name}</strong><p>{applicationStatus(device)} · 期望版本 {
        device.desired_revision} · 已应用版本 {device.applied_revision ?? '未知'}</p>
        {device.last_error && <p>错误：{device.last_error}</p>}</div>
    </li>)}</ul>
    <div className="gateway-admin-pagination"><span>共 {total} 台设备 · 第 {page}/{
      Math.max(1, Math.ceil(total / 25))} 页</span>
      <button type="button" disabled={page <= 1 || loading} onClick={() => setPage(value => value - 1)}>上一页</button>
      <button type="button" disabled={page >= Math.ceil(total / 25) || loading}
        onClick={() => setPage(value => value + 1)}>下一页</button></div>
  </section>
}
