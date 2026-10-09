import { PasswordConfirmation, confirmStepUp, useStepUpPassword } from './PasswordConfirmation'
import { useEffect, useState } from 'react'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'

type Device = { id: string; name: string; online: boolean; daemon_health: boolean | null }
type Candidate = { host_project_id: string; name: string; published: boolean }

export function AdminPublishProjectPanel({ csrf, revision, onPublished }: {
  csrf: string; revision: number; onPublished: () => void
}) {
  const [devices, setDevices] = useState<Device[]>([])
  const [deviceTotal, setDeviceTotal] = useState(0)
  const [devicePage, setDevicePage] = useState(1)
  const [deviceRevision, setDeviceRevision] = useState(0)
  const [deviceLoading, setDeviceLoading] = useState(false)
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null)
  const [projects, setProjects] = useState<Candidate[]>([])
  const [projectTotal, setProjectTotal] = useState(0)
  const [projectPage, setProjectPage] = useState(1)
  const [projectQuery, setProjectQuery] = useState('')
  const [projectSearch, setProjectSearch] = useState('')
  const [projectRevision, setProjectRevision] = useState(0)
  const [projectLoading, setProjectLoading] = useState(false)
  const [selectedProject, setSelectedProject] = useState<Candidate | null>(null)
  const { password, setPassword, passwordRequired, passwordReady } = useStepUpPassword()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    const controller = new AbortController()
    setDeviceLoading(true); setError('')
    void fetch(`/api/admin/devices?status=active&sort=name&direction=asc&page=${devicePage}&page_size=25`, {
      credentials: 'same-origin', signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error('设备列表加载失败。')
      const data = await response.json()
      if (!controller.signal.aborted) { setDevices(data.devices ?? []); setDeviceTotal(data.total ?? 0) }
    }).catch(reason => {
      if (reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : '设备列表加载失败。')
    }).finally(() => { if (!controller.signal.aborted) setDeviceLoading(false) })
    return () => controller.abort()
  }, [devicePage, deviceRevision])

  useEffect(() => {
    if (!selectedDevice) return
    const controller = new AbortController()
    const params = new URLSearchParams({ q: projectSearch, page: String(projectPage), page_size: '25' })
    setProjectLoading(true); setError('')
    void fetch(`/api/admin/devices/${encodeURIComponent(selectedDevice.id)}/publishable-projects?${params}`, {
      credentials: 'same-origin', signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error(response.status === 503
        ? 'PC 已离线或项目目录暂不可用。' : '可发布项目加载失败。')
      const data = await response.json()
      if (!controller.signal.aborted) { setProjects(data.projects ?? []); setProjectTotal(data.total ?? 0) }
    }).catch(reason => {
      if (reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : '可发布项目加载失败。')
    }).finally(() => { if (!controller.signal.aborted) setProjectLoading(false) })
    return () => controller.abort()
  }, [selectedDevice, projectPage, projectSearch, projectRevision, revision])

  async function publish() {
    if (!selectedDevice || !selectedProject) return
    setBusy(true); setError('')
    try {
      const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }
      const step = await confirmStepUp(csrf, password, passwordRequired)
      if (!step.ok) throw new Error('密码验证失败。')
      const response = await fetch(`/api/admin/devices/${encodeURIComponent(selectedDevice.id)}/projects/${encodeURIComponent(selectedProject.host_project_id)}/publish`, {
        method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf },
      })
      if (!response.ok) throw new Error(response.status === 404
        ? '项目已不在这台 PC 的目录中，请刷新列表。' : '发布项目失败。')
      setSelectedProject(null); setPassword(''); onPublished()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '发布项目失败。') }
    finally { setBusy(false) }
  }

  return <section className="gateway-project-grants">
    <p className="gateway-publication-step">{selectedDevice ? '第 2 步 · 选择项目' : '第 1 步 · 选择宿主电脑'}</p>
    <p>Gateway 仅接收 PC 登记的项目 ID 和名称，不读取宿主目录路径或项目内容。</p>
    {!selectedDevice && <>
    {deviceLoading && <p role="status">正在加载设备…</p>}
    {!deviceLoading && devices.length === 0 && <p>暂无可用电脑。请先在 PC 客户端连接平台并登记设备。</p>}
    <ul className="gateway-device-list">{devices.map(device => <li key={device.id}>
      <div><strong>{device.name}</strong><p>{device.online ? '控制连接在线' : '离线'} · daemon {
        device.daemon_health === true ? '正常' : device.daemon_health === false ? '异常' : '未知'}</p></div>
      <button type="button" disabled={!device.online || device.daemon_health === false} onClick={() => {
        setSelectedDevice(device); setProjectPage(1); setProjectSearch(''); setProjectQuery(''); setProjects([]); setError(''); setProjectLoading(true)
      }}>查看可发布项目</button>
    </li>)}</ul>
    <div className="gateway-admin-pagination"><span>共 {deviceTotal} 台有效设备 · 第 {devicePage}/{
      Math.max(1, Math.ceil(deviceTotal / 25))} 页</span>
      <button type="button" disabled={devicePage <= 1 || deviceLoading}
        onClick={() => setDevicePage(value => value - 1)}>上一页</button>
      <button type="button" disabled={devicePage >= Math.ceil(deviceTotal / 25) || deviceLoading}
        onClick={() => setDevicePage(value => value + 1)}>下一页</button></div>
    </>}
    {selectedDevice && <section className="gateway-project-catalog">
      <div className="gateway-admin-toolbar"><h4>{selectedDevice.name} · 可发布项目</h4>
        <button type="button" className="gateway-project-secondary" onClick={() => {
          setSelectedDevice(null); setProjects([]); setError('')
        }}>重新选择电脑</button></div>
      <form className="gateway-admin-search" onSubmit={event => {
        event.preventDefault(); setProjectPage(1); setProjectSearch(projectQuery.trim())
      }}><label htmlFor="publish-project-search">搜索 PC 项目</label>
        <input id="publish-project-search" value={projectQuery}
          onChange={event => setProjectQuery(event.target.value)} />
        <button type="submit">搜索</button></form>
      {projectLoading && <p role="status">正在向 PC 获取项目目录…</p>}
      {!projectLoading && !error && projects.length === 0 && <p>当前 PC 没有匹配的项目。</p>}
      <ul className="gateway-device-list">{projects.map(project => <li key={project.host_project_id}>
        <div><strong>{project.name}</strong><p>{project.host_project_id} · {
          project.published ? '已发布' : '未发布'}</p></div>
        <button type="button" disabled={project.published || projectLoading} onClick={() => { setError(''); setSelectedProject(project) }}>
          {project.published ? '已发布' : '发布'}</button>
      </li>)}</ul>
      <div className="gateway-admin-pagination"><span>共 {projectTotal} 个项目 · 第 {projectPage}/{
        Math.max(1, Math.ceil(projectTotal / 25))} 页</span>
        <button type="button" disabled={projectPage <= 1 || projectLoading}
          onClick={() => setProjectPage(value => value - 1)}>上一页</button>
        <button type="button" disabled={projectPage >= Math.ceil(projectTotal / 25) || projectLoading}
          onClick={() => setProjectPage(value => value + 1)}>下一页</button></div>
    </section>}
    {error && <p role="alert" className="gateway-auth-error">{error} <button type="button"
      onClick={() => selectedDevice ? setProjectRevision(value => value + 1) : setDeviceRevision(value => value + 1)}>
        重试</button></p>}
    {selectedProject && selectedDevice && <GatewayConfirmDialog title="发布平台项目"
      message={`从 ${selectedDevice.name} 发布「${selectedProject.name}」。提交时会再次向在线 PC 核对项目。`}
      confirmLabel="确认发布" busy={busy} disabled={!passwordReady} onConfirm={() => void publish()}
      onCancel={() => { setSelectedProject(null); setPassword('') }}>
      <PasswordConfirmation id="publish-project-password" label="输入管理员密码确认" value={password} onChange={setPassword} />
      {error && <p role="alert" className="gateway-auth-error">{error}</p>}
    </GatewayConfirmDialog>}
  </section>
}

export function AdminUnpublishProjectDialog({ project, csrf, onClose, onComplete }: {
  project: { id: string; name: string }; csrf: string; onClose: () => void; onComplete: () => void
}) {
  const { password, setPassword, passwordRequired, passwordReady } = useStepUpPassword()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  async function unpublish() {
    setBusy(true); setError('')
    try {
      const headers = { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }
      const step = await confirmStepUp(csrf, password, passwordRequired)
      if (!step.ok) throw new Error('密码验证失败。')
      const response = await fetch(`/api/admin/projects/${encodeURIComponent(project.id)}/unpublish`, {
        method: 'POST', credentials: 'same-origin', headers: { 'X-CSRF-Token': csrf },
      })
      if (!response.ok) throw new Error('取消发布失败。')
      onComplete()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '取消发布失败。') }
    finally { setBusy(false) }
  }
  return <GatewayConfirmDialog title="取消项目发布"
    message={`确认取消「${project.name}」的发布？只移除 Gateway 登记和访问授权，不删除宿主 PC 的项目目录或数据。`}
    confirmLabel="取消发布" busy={busy} disabled={!passwordReady} onConfirm={() => void unpublish()} onCancel={onClose}>
    <PasswordConfirmation id="unpublish-project-password" label="输入管理员密码确认" value={password} onChange={setPassword} />
    {error && <p role="alert" className="gateway-auth-error">{error}</p>}
  </GatewayConfirmDialog>
}
