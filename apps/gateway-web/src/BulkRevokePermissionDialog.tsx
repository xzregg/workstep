import { useRef, useState } from 'react'
import { GatewayModal } from './GatewayModal'
import { PasswordConfirmation, confirmStepUp, useStepUpPassword } from './PasswordConfirmation'
import { revokePermission, scopeNames, type PermissionAssignment } from './PermissionDialogs'

export function BulkRevokePermissionDialog({ assignments, name, csrf, onFinished }: {
  assignments: PermissionAssignment[]; name: (permission: string) => string; csrf: string
  onFinished: (completed: string[]) => void
}) {
  const { password, setPassword, passwordRequired, passwordReady } = useStepUpPassword()
  const [completed, setCompleted] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const pending = useRef(false)
  const done = useRef<string[]>([])
  const close = () => { if (!pending.current) onFinished([...done.current]) }
  async function revoke() {
    if (!csrf || !passwordReady || pending.current || !assignments.length) return
    pending.current = true; setBusy(true); setError('')
    try {
      const confirmation = await confirmStepUp(csrf, password, passwordRequired)
      if (!confirmation.ok) throw Error('管理员身份验证失败，请重试。')
      for (const row of assignments) {
        if (done.current.includes(row.id)) continue
        try { await revokePermission(row.id, csrf) }
        catch (reason) {
          throw Error(`${row.subject_name} · ${name(row.permission)}（${row.scope_name}）：${reason instanceof Error ? reason.message : '撤销失败，请重试。'}`)
        }
        done.current.push(row.id)
        setCompleted([...done.current])
      }
      onFinished([...done.current])
    } catch (reason) { setError(reason instanceof Error ? reason.message : '批量撤销失败，请重试。') }
    finally { pending.current = false; setBusy(false) }
  }
  return <GatewayModal title="批量撤销权限" className="gateway-bulk-revoke-dialog" onClose={close} footer={<>
    <button type="button" disabled={busy} onClick={close}>取消</button>
    <button type="button" disabled={busy || !csrf || !passwordReady || !assignments.length} onClick={() => void revoke()}>
      {busy ? '处理中…' : completed.length ? '重试剩余权限' : '撤销所选权限'}
    </button>
  </>}
      passwordConfirmation={<PasswordConfirmation label="输入管理员密码确认" value={password} onChange={setPassword} disabled={busy} />}>
    <p>将撤销所选 {assignments.length} 条直接授权规则，涉及 {new Set(assignments.map(row => `${row.subject_type}:${row.subject_id}`)).size} 个授权对象。</p>
    <p>撤销允许或禁止规则后，其他个人或组授权仍可能生效。已完成的撤销不会因取消而恢复。</p>
    <ul className="gateway-bulk-revoke-rules">{assignments.map(row => <li key={row.id}>
      <strong>{row.subject_name}</strong>（{row.subject_type === 'user' ? '用户' : '用户组'}） · {name(row.permission)} · {scopeNames[row.scope_type]} · {row.scope_name} · {row.effect === 'allow' ? '允许' : '禁止'}
      {completed.includes(row.id) && <span> · 已撤销</span>}
    </li>)}</ul>
    {(busy || completed.length > 0) && <p role="status">{busy && <span className="gateway-spinner" aria-hidden="true" />} 已处理 {completed.length}/{assignments.length} 条规则；重试仅处理剩余规则。</p>}
    {error && <p role="alert" className="gateway-auth-error">{error}</p>}
  </GatewayModal>
}
