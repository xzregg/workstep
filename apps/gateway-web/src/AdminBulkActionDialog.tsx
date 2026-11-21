import { localizeGatewayError } from './gatewayErrorText'
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
    if (!step.ok) throw Error('Password verification failed, please try again.')
   }
   const result = await fetch(action.url, {method:'POST',credentials:'same-origin',headers,body:JSON.stringify(action.body)})
   if (!result.ok) throw Error(result.status === 409 ? 'Operation conflict: Please confirm the account status, retain at least one super administrator, and do not modify organization-synced members.'
    : result.status === 403 ? 'Insufficient permissions. Accounts outside the administrator and scope cannot be operated.' : 'Operation failed. Please refresh the list and try again.')
   onDone()
  } catch(reason) {setError(reason instanceof Error ? reason.message : 'Operation failed, please try again.')}
  finally {submitted.current=false; setBusy(false)}
 }
 return <GatewayConfirmDialog title={action.title} message={action.message} confirmLabel={action.label}
  busy={busy} disabled={!csrf || (!!action.password && !passwordReady)} onCancel={onClose} onConfirm={()=>void submit()}
      passwordConfirmation={action.password && <PasswordConfirmation label="输入你的密码确认" value={password} onChange={setPassword} />}>
  {busy && <p role="status"><span className="gateway-spinner"/> 正在提交操作…</p>}
  {error && <p role="alert" className="gateway-auth-error">{localizeGatewayError(error)}</p>}
 </GatewayConfirmDialog>
}
