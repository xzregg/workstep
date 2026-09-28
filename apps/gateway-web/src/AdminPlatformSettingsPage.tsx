import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AdminRegistrationPolicyDialog, registrationLabels } from './AdminRegistrationPolicyDialog'
import type { RegistrationMode } from './AdminRegistrationPolicyDialog'

type PlatformSettings = {
  gateway_id: string; public_origin: string | null; registration_mode: RegistrationMode
  session_seconds: number; protocol_version: number; data_dir: string
  database: { backend: string; location: string; healthy: boolean; migration_version: string | null }
}

export function AdminPlatformSettingsPage() {
  const [settings, setSettings] = useState<PlatformSettings | null>(null)
  const [csrf, setCsrf] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [editing, setEditing] = useState(false)

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
    <span className="gateway-auth-eyebrow">WORKSTEP GATEWAY · ADMIN</span>
    <div className="gateway-admin-toolbar"><h2>平台设置</h2><Link to="/admin">返回管理概览</Link></div>
    {loading && <p role="status">正在加载平台设置…</p>}
    {error && <p role="alert" className="gateway-auth-error">{error} <button type="button"
      onClick={() => setRevision(current => current + 1)}>重试</button></p>}
    {!loading && !error && settings && <>
      <section className="gateway-project-grants"><h3>平台信息</h3>
        <dl className="gateway-account-summary">
          <div><dt>网关 ID</dt><dd>{settings.gateway_id}</dd></div>
          <div><dt>公网地址</dt><dd>{settings.public_origin ?? '未配置'}</dd></div>
          <div><dt>会话有效期</dt><dd>{settings.session_seconds / 3600} 小时</dd></div>
        </dl>
      </section>
      <section className="gateway-project-grants"><h3>注册与身份</h3>
        <p>当前策略：{registrationLabels[settings.registration_mode]}</p>
        <button type="button" onClick={() => setEditing(true)}>修改注册策略</button>
        <p>钉钉、企业微信身份源与目录对账在<Link to="/admin/org">组织与同步</Link>管理。</p>
      </section>
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
    {editing && settings && <AdminRegistrationPolicyDialog mode={settings.registration_mode} csrf={csrf}
      onClose={() => setEditing(false)} onSaved={() => {
        setEditing(false); setRevision(current => current + 1)
      }} />}
  </section>
}
