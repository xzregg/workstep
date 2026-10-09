import { PasswordConfirmation, confirmStepUp, useStepUpPassword } from './PasswordConfirmation'
import { useRef, useState } from 'react'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'

export function AdminLoginPolicyDialog({enabled, csrf, onClose, onSaved}: {
 enabled: boolean; csrf: string; onClose: () => void; onSaved: () => void
}) {
 const [selected,setSelected]=useState(enabled)
 const { password, setPassword, passwordRequired, passwordReady } = useStepUpPassword()
 const [busy,setBusy]=useState(false)
 const [error,setError]=useState('')
 const [discard,setDiscard]=useState(false)
 const submitting=useRef(false)
 async function save() {
  if(submitting.current || selected===enabled || !passwordReady || !csrf)return
  submitting.current=true;setBusy(true);setError('')
  try{
   const headers={'Content-Type':'application/json','X-CSRF-Token':csrf}
   const proof=await confirmStepUp(csrf, password, passwordRequired)
   if(!proof.ok)throw Error('管理员密码验证失败。')
   const result=await fetch('/api/admin/login-policy',{method:'PUT',credentials:'same-origin',headers,body:JSON.stringify({password_login_enabled:selected})})
   if(!result.ok)throw Error(result.status===409?'请先配置并启用至少一个钉钉或企业微信扫码登录应用。':'登录方式保存失败，请检查权限后重试。')
   onSaved()
  }catch(reason){setError(reason instanceof Error?reason.message:'保存失败。')}
  finally{submitting.current=false;setBusy(false)}
 }
 function close(){if(selected!==enabled || password)setDiscard(true);else onClose()}
 return <>
  <GatewayConfirmDialog title="修改登录方式" message="关闭账号密码登录后，登录页仅提供已启用的企业扫码入口，自主注册也会关闭。"
   confirmLabel="保存登录方式" busy={busy} disabled={!csrf || selected===enabled || !passwordReady} onCancel={close} onConfirm={()=>void save()}>
   <label className="gateway-check-label"><input type="checkbox" checked={selected} disabled={busy} onChange={event=>setSelected(event.target.checked)}/>启用账号密码登录</label>
   <p>钉钉和企业微信扫码入口在下方应用配置中分别启用。现有账号和会话保留，重新启用后恢复原注册策略。</p>
   <PasswordConfirmation label="管理员密码" value={password} onChange={setPassword} disabled={busy} />
   {busy && <p role="status"><span className="gateway-spinner"/>正在保存登录方式…</p>}
   {error && <p role="alert" className="gateway-auth-error">{error}</p>}
  </GatewayConfirmDialog>
  {discard && <GatewayConfirmDialog title="放弃登录方式修改" message="登录方式尚未保存。" confirmLabel="放弃并关闭" onConfirm={onClose} onCancel={()=>setDiscard(false)}/>}
 </>
}
