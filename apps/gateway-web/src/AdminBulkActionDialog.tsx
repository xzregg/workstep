import { PasswordConfirmation, confirmStepUp, useStepUpPassword } from './PasswordConfirmation'
import { useRef, useState } from 'react'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'

export type BulkAction = {title: string; label: string; message: string; url: string; body: object; password?: boolean}
export function AdminBulkActionDialog({action, csrf, onClose, onDone}: {
 action: BulkAction; csrf: string; onClose: () => void; onDone: () => void
}) {
 const { password, setPassword, passwordRequired, passwordReady } = useStepUpPassword()
 const [busy, setBusy] = useState(false)
 const [error, setError] = useState('')
 const submitted = useRef(false)
 async function submit() {
  if (submitted.current || !csrf || (action.password && !passwordReady)) return
  submitted.current = true; setBusy(true); setError('')
  try {
   const headers = {'Content-Type':'application/json','X-CSRF-Token':csrf}
   if (action.password) {
    const step = await confirmStepUp(csrf, password, passwordRequired)
    if (!step.ok) throw Error('密码验证失败，请重试。')
   }
   const result = await fetch(action.url, {method:'POST',credentials:'same-origin',headers,body:JSON.stringify(action.body)})
   if (!result.ok) throw Error(result.status === 409 ? '操作冲突：请确认账号状态、保留至少一位超级管理员，并勿修改组织同步成员。'
    : result.status === 403 ? '权限不足，恢复管理员及范围外的账号不能操作。' : '操作失败，请刷新列表后重试。')
   onDone()
  } catch(reason) {setError(reason instanceof Error ? reason.message : '操作失败，请重试。')}
  finally {submitted.current=false; setBusy(false)}
 }
 return <GatewayConfirmDialog title={action.title} message={action.message} confirmLabel={action.label}
  busy={busy} disabled={!csrf || (!!action.password && !passwordReady)} onCancel={onClose} onConfirm={()=>void submit()}>
  {action.password && <PasswordConfirmation label="输入你的密码确认" value={password} onChange={setPassword} />}
  {busy && <p role="status"><span className="gateway-spinner"/> 正在提交操作…</p>}
  {error && <p role="alert" className="gateway-auth-error">{error}</p>}
 </GatewayConfirmDialog>
}
