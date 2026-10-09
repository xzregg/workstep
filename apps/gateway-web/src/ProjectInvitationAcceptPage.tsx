import { useEffect, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { openRemoteAccess } from './openRemoteAccess'
import { invitationHeaders, invitationResponse, invitationTokenPattern, useInvitationSession } from './projectInvitationApi'

type Preview = { project_id: string; project_name: string; device_name: string;
  access_level: string; created_by: string; expires_at: string | null }

export function ProjectInvitationAcceptPage() {
  const { token = '' } = useParams()
  const location = useLocation()
  const { session, status, retry } = useInvitationSession()
  const [preview, setPreview] = useState<Preview | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [accepted, setAccepted] = useState<{ project_id: string; access_level: string } | null>(null)
  const valid = invitationTokenPattern.test(token)
  useEffect(() => {
    if (status !== 'ready' || !valid) return
    const controller = new AbortController()
    setLoading(true); setError(''); setPreview(null); setAccepted(null)
    void fetch(`/api/project-invitations/${token}`, { signal: controller.signal })
      .then(invitationResponse).then(data => { if (!controller.signal.aborted) setPreview(data) })
      .catch(reason => { if (reason?.name !== 'AbortError') setError(reason.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [status, token, valid, revision])

  async function accept() {
    if (busy || !session || !preview) return
    setBusy(true); setError('')
    try {
      setAccepted(await invitationResponse(await fetch(`/api/project-invitations/${token}/accept`, {
        method: 'POST', headers: invitationHeaders(session.csrf_token),
      })))
    } catch (reason) { setError(reason instanceof Error ? reason.message : '添加失败，请重试。') }
    finally { setBusy(false) }
  }

  async function enter() {
    if (busy || !accepted) return
    setBusy(true); setError('')
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(accepted.project_id)}/access`)
      if (response.status === 409) throw Error('宿主设备当前离线，请等待上线后重试。项目已保存在你的列表中。')
      openRemoteAccess(await invitationResponse(response))
    } catch (reason) { setError(reason instanceof Error ? reason.message : '进入项目失败，请重试。') }
    finally { setBusy(false) }
  }

  return <section className="gateway-auth-card gateway-project-invitation-accept">
    <h2>接受项目邀请</h2>
    {!valid && <p role="alert">项目邀请链接格式无效。</p>}
    {valid && status === 'login' && <p>请先<Link to={`/auth?next=${encodeURIComponent(location.pathname)}`}>登录 / 注册</Link>，然后确认添加项目。不需要注册设备。</p>}
    {status === 'error' && <p role="alert">登录状态加载失败。<button onClick={retry}>重试</button></p>}
    {(status === 'loading' || loading) && <p role="status"><span className="gateway-spinner" /> 正在加载邀请…</p>}
    {preview && !loading && <>
      <h3>{preview.project_name}</h3>
      <p>分享者：{preview.created_by} · 宿主设备：{preview.device_name}</p>
      <p>访问级别：{(accepted?.access_level ?? preview.access_level) === 'edit' ? '可编辑' : '只读'}</p>
      <p>邀请过期时间：{preview.expires_at ? new Date(preview.expires_at).toLocaleString() : '未设置'}</p>
      {accepted ? <>
        <p role="status">项目已添加。你可以通过网关进入此项目，无需拥有设备。</p>
        <button type="button" disabled={busy} onClick={() => void enter()}>{busy && <span className="gateway-spinner" />}进入项目</button>
        <Link to="/devices">查看我的项目</Link>
      </> : <>
        <p>确认后授予当前账号此项目的访问权限，管理员可以随时撤销。项目文件与执行仍在宿主设备上。</p>
        <button type="button" disabled={busy} onClick={() => void accept()}>{busy && <span className="gateway-spinner" />}{busy ? '正在添加…' : '添加项目'}</button>
      </>}
    </>}
    {error && <p role="alert" className="gateway-auth-error">{error} {!preview && <button onClick={() => setRevision(v => v + 1)}>重试加载</button>}</p>}
    <Link to="/project-invitations">返回项目分享与添加</Link>
  </section>
}
