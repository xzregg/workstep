import { PlatformAddress } from './PlatformAddress'
import { AdminPlatformAddressDialog } from './AdminPlatformAddressDialog'
import { OrganizationSyncSettings } from './OrganizationSyncSettings'
import { AdminLoginPolicyDialog } from './AdminLoginPolicyDialog'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AdminRegistrationPolicyDialog, registrationLabels } from './AdminRegistrationPolicyDialog'
import type { RegistrationMode } from './AdminRegistrationPolicyDialog'

type PlatformSettings = {
  gateway_id: string; public_origin: string | null; registration_mode: RegistrationMode
  device_approval_mode?: 'manual' | 'automatic'
  password_login_enabled?: boolean
  session_seconds: number | null; protocol_version: number; data_dir: string
  database: { backend: string; location: string; healthy: boolean; migration_version: string | null }
}

export function AdminPlatformSettingsPage() {
  const [settings, setSettings] = useState<PlatformSettings | null>(null)
  const [csrf, setCsrf] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [deviceEditing, setDeviceEditing] = useState(false)
  const [editing, setEditing] = useState(false)
  const [loginEditing,setLoginEditing]=useState(false)
  const [addressEditing, setAddressEditing] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    void Promise.all([
      fetch('/api/admin/platform-settings', { credentials: 'same-origin', signal: controller.signal }),
      fetch('/api/auth/session', { credentials: 'same-origin', signal: controller.signal }),
    ]).then(async ([response, session]) => {
      if (!response.ok || !session.ok) throw new Error('平台设置加载失败。')
      const [data, auth] = await Promise.all([response.json(), session.json()])
      if (!controller.signal.aborted) { setSettings(data); setCsrf(auth.csrf_token) }
    }).catch(reason => {
      if (!controller.signal.aborted && reason?.name !== 'AbortError') {
        setError(reason instanceof Error ? reason.message : '平台设置加载失败。')
      }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [revision])

  return <section className="gateway-admin-page">
    <span className="gateway-auth-eyebrow">WORKSTEP 平台 · ADMIN</span>
    <div className="gateway-admin-toolbar"><h2>平台设置</h2><Link to="/admin">返回管理概览</Link></div>
    {loading && <p role="status">正在加载平台设置…</p>}
    {error && <p role="alert" className="gateway-auth-error">{error} <button type="button"
      onClick={() => setRevision(current => current + 1)}>重试</button></p>}
    {!loading && !error && settings && <>
      <section className="gateway-project-grants"><h3>平台信息</h3>
        <dl className="gateway-account-summary">
          <div><dt>网关 ID</dt><dd>{settings.gateway_id}</dd></div>
          <div><dt>平台地址</dt><dd><PlatformAddress address={settings.public_origin}/></dd></div>
          <div><dt>会话有效期</dt><dd>{settings.session_seconds == null ? '不过期（退出或撤销后失效）' : `${settings.session_seconds / 3600} 小时`}</dd></div>
        </dl>
        <button type="button" onClick={() => setAddressEditing(true)}>修改平台地址</button>
        <p>复制后粘贴到 WorkStep「设置 → 远程访问 → 网关平台」的地址栏。安装页也会显示此地址。</p>
      </section>
      <section className="gateway-project-grants"><h3>注册与身份</h3>
        <p>账号密码登录：{settings.password_login_enabled === false ? '已关闭，仅企业扫码登录' : '已启用'}</p>
        <button type="button" onClick={()=>setLoginEditing(true)}>修改登录方式</button>
        <p>当前策略：{registrationLabels[settings.registration_mode]}</p>
        {settings.password_login_enabled === false && <p>账号密码登录已关闭，当前不开放自主注册。</p>}
        <button type="button" onClick={() => setEditing(true)}>修改注册策略</button>

      </section>
      <section className="gateway-project-grants"><h3>设备审批</h3>
        <p>当前策略：{settings.device_approval_mode === 'automatic' ? '自动审批' : '人工审批'}</p>
        <p>自动审批允许已登录用户的新设备直接启用；人工审批需要管理员批准。</p>
        <button type="button" onClick={() => setDeviceEditing(true)}>修改设备审批策略</button>
      </section>
      <OrganizationSyncSettings csrf={csrf} platformAddress={settings.public_origin} />
      <section className="gateway-project-grants"><h3>客户端与数据</h3>
        <dl className="gateway-account-summary">
          <div><dt>网关协议版本</dt><dd>{settings.protocol_version}</dd></div>
          <div><dt>数据目录</dt><dd>{settings.data_dir}</dd></div>
          <div><dt>数据库</dt><dd>{settings.database.backend} · {settings.database.location}</dd></div>
          <div><dt>数据库状态</dt><dd>{settings.database.healthy ? '正常' : '异常'}</dd></div>
          <div><dt>迁移版本</dt><dd>{settings.database.migration_version ?? '未知'}</dd></div>
        </dl>
        <p>数据库连接配置由服务端部署管理，不能在此页面热切换。</p>
      </section>
    </>}
    {deviceEditing && settings && <AdminRegistrationPolicyDialog devicePolicy mode={settings.device_approval_mode ?? 'manual'} csrf={csrf}
      onClose={() => setDeviceEditing(false)} onSaved={() => { setDeviceEditing(false); setRevision(value => value + 1) }} />}
    {addressEditing && settings && <AdminPlatformAddressDialog address={settings.public_origin} csrf={csrf}
      onClose={() => setAddressEditing(false)} onSaved={() => {setAddressEditing(false); setRevision(current => current + 1)}}/>}
    {editing && settings && <AdminRegistrationPolicyDialog mode={settings.registration_mode} csrf={csrf}
      onClose={() => setEditing(false)} onSaved={() => {
        setEditing(false); setRevision(current => current + 1)
      }} />}
    {loginEditing && settings && <AdminLoginPolicyDialog enabled={settings.password_login_enabled !== false} csrf={csrf}
      onClose={()=>setLoginEditing(false)} onSaved={()=>{setLoginEditing(false);setRevision(value=>value+1)}}/>}
  </section>
}
