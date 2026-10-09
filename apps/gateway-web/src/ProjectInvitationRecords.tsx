import { useEffect, useState } from 'react'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'
import { PasswordConfirmation, confirmStepUp, useStepUpPassword } from './PasswordConfirmation'
import { AdminProjectGrantDialog, AdminProjectRevokeDialog, type ProjectGrant } from './AdminProjectGrantDialog'
import { invitationHeaders, invitationResponse } from './projectInvitationApi'

type Member = { user_id: string; name: string; status: string; access_level: 'read' | 'edit'; accepted_at: string }
type Invitation = { id: string; status: string; access_level: string; created_by: string;
  created_at: string; expires_at: string | null; members: Member[] }
type Operation = { action: 'pause' | 'resume' | 'revoke'; id: string } | { action: 'policy'; enabled: boolean }
const statusLabel: Record<string, string> = { active: '有效', paused: '已暂停', revoked: '已撤销', expired: '已过期', blocked: '已禁止访问' }

export function ProjectInvitationRecords({ projectId, csrf, admin = false, revision = 0, onChanged }: {
  projectId: string; csrf: string; admin?: boolean; revision?: number; onChanged?: () => void
}) {
  const [listing, setListing] = useState<{ invitations_enabled: boolean; invitations: Invitation[] } | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [localRevision, setLocalRevision] = useState(0)
  const [operation, setOperation] = useState<Operation | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [revoke, setRevoke] = useState<ProjectGrant | null>(null)
  const [restore, setRestore] = useState<ProjectGrant | null>(null)
  const { password, setPassword, passwordRequired, passwordReady } = useStepUpPassword()
  const base = `/api/${admin ? 'admin/' : ''}projects/${encodeURIComponent(projectId)}`

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setLoadError('')
    void fetch(base + '/invitations', { signal: controller.signal })
      .then(invitationResponse).then(data => { if (!controller.signal.aborted) setListing(data) })
      .catch(reason => { if (reason?.name !== 'AbortError') setLoadError(reason.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [base, revision, localRevision])

  function saved() {
    setRevoke(null); setRestore(null); setLocalRevision(v => v + 1); onChanged?.()
  }
  function choose(next: Operation) { setError(''); setPassword(''); setOperation(next) }
  async function change() {
    if (!operation || busy) return
    setBusy(true); setError('')
    try {
      if (admin && !(await confirmStepUp(csrf, password, passwordRequired)).ok) throw Error('管理员身份确认失败，请重试。')
      const policy = operation.action === 'policy'
      await invitationResponse(await fetch(policy ? base + '/invitation-policy' : base + `/invitations/${operation.id}/${operation.action}`, {
        method: policy ? 'PUT' : 'POST', headers: invitationHeaders(csrf),
        ...(policy ? { body: JSON.stringify({ enabled: operation.enabled }) } : {}),
      }))
      setOperation(null); setPassword(''); saved()
    } catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败，请重试。') }
    finally { setBusy(false) }
  }

  const title = operation?.action === 'policy' ? operation.enabled ? '允许邀请加入' : '禁止邀请加入'
    : operation?.action === 'revoke' ? '撤销项目邀请' : operation?.action === 'pause' ? '暂停项目邀请' : '恢复项目邀请'
  const message = operation?.action === 'policy' ? '此设置控制生成邀请和通过邀请添加项目，不改变现有用户的访问权限。'
    : operation?.action === 'revoke' ? '链接将永久失效，仍由此邀请授予的项目访问权限也将撤销。管理员重新授予的权限保留。'
    : operation?.action === 'pause' ? '暂停后无法通过此链接添加项目，已加入用户仍可访问。' : '恢复后用户可以继续通过此邀请添加项目。'
  function memberGrant(member: Member): ProjectGrant {
    return { id: member.user_id, subject_type: 'user', subject_id: member.user_id,
      subject_name: member.name, access_level: member.access_level }
  }

  return <section className="gateway-project-invitation-records">
    <h3>{admin ? '项目邀请与加入记录' : '我创建的项目邀请'}</h3>
    {loading && <p role="status"><span className="gateway-spinner" /> 正在加载邀请记录…</p>}
    {loadError && <p role="alert">{loadError} <button onClick={() => setLocalRevision(v => v + 1)}>重试加载</button></p>}
    {listing && <>
      <p>邀请加入：{listing.invitations_enabled ? '允许' : '已禁止'}。链接只在生成时显示，请及时保存。</p>
      {admin && <button type="button" onClick={() => choose({ action: 'policy', enabled: !listing.invitations_enabled })}>
        {listing.invitations_enabled ? '禁止邀请加入' : '允许邀请加入'}</button>}
      {!listing.invitations.length && <p>尚无项目邀请。</p>}
      {listing.invitations.map(invitation => <article className="gateway-project-invitation-record" key={invitation.id}>
        <strong>{statusLabel[invitation.status]} · {invitation.access_level === 'edit' ? '可编辑' : '只读'} · {invitation.members.length} 人加入</strong>
        <p>分享者：{invitation.created_by} · 创建：{new Date(invitation.created_at).toLocaleString()} · 过期：{invitation.expires_at ? new Date(invitation.expires_at).toLocaleString() : '未设置'}</p>
        <div className="gateway-project-invitation-record-actions">
          {admin && invitation.status === 'active' && <button onClick={() => choose({ action: 'pause', id: invitation.id })}>暂停邀请</button>}
          {admin && invitation.status === 'paused' && <button onClick={() => choose({ action: 'resume', id: invitation.id })}>恢复邀请</button>}
          {invitation.status !== 'revoked' && <button onClick={() => choose({ action: 'revoke', id: invitation.id })}>撤销邀请</button>}
        </div>
        {!!invitation.members.length && <ul>{invitation.members.map(member => <li className="gateway-project-invitation-member" key={member.user_id}>
          <span>{member.name} · {statusLabel[member.status]} · {member.access_level === 'edit' ? '可编辑' : '只读'} · 加入：{new Date(member.accepted_at).toLocaleString()}</span>
          {admin && (member.status === 'active'
            ? <button onClick={() => setRevoke(memberGrant(member))}>撤销 {member.name} 的授权</button>
            : <button onClick={() => setRestore(memberGrant(member))}>重新授权 {member.name}</button>)}
        </li>)}</ul>}
      </article>)}
    </>}
    {operation && <GatewayConfirmDialog title={title} message={message}
      confirmLabel={operation.action === 'policy' && !operation.enabled ? '确认禁止' : '确认'}
      busy={busy} disabled={admin && !passwordReady} onCancel={() => setOperation(null)} onConfirm={() => void change()}>
      {admin && <PasswordConfirmation label="输入管理员密码确认" value={password} onChange={setPassword} />}
      {busy && <span className="gateway-spinner" />}
      {error && <p role="alert" className="gateway-auth-error">{error}</p>}
    </GatewayConfirmDialog>}
    {revoke && <AdminProjectRevokeDialog projectId={projectId} grant={revoke} csrf={csrf} onClose={() => setRevoke(null)} onSaved={saved} />}
    {restore && <AdminProjectGrantDialog projectId={projectId} grant={restore} csrf={csrf} onClose={() => setRestore(null)} onSaved={saved} />}
  </section>
}
