import { useEffect, useRef, useState } from 'react'
import { PasswordConfirmation, confirmStepUp, useStepUpPassword } from './PasswordConfirmation'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'
import { thirdPartyError, validThirdPartyCallback } from './thirdPartyAuth'

const endpoint='/api/admin/third-party-auth-settings'

export function ThirdPartyAuthSettings({csrf}: {csrf: string}) {
 const [urls,setUrls]=useState<string[]|null>(null)
 const [error,setError]=useState('')
 const [retry,setRetry]=useState(0)
 const [editing,setEditing]=useState(false)
 useEffect(()=>{
  const controller=new AbortController()
  setError('')
  void fetch(endpoint,{credentials:'same-origin',signal:controller.signal})
   .then(async response=>{if(!response.ok)throw Error('回调白名单加载失败。');return response.json()})
   .then(body=>{if(!controller.signal.aborted)setUrls(body.callback_urls)})
   .catch(reason=>{if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'加载失败。')})
  return ()=>controller.abort()
 },[retry])
 return <section className="gateway-project-grants gateway-third-party-settings">
  <h3>第三方登录授权</h3>
  <p>登记完整回调 URL 后，该系统可通过网关登录并获取用户 ID、账号和显示名。支持 HTTP 和 HTTPS，地址须完全匹配。</p>
  {error&&<p role="alert" className="gateway-auth-error">{error} <button type="button" onClick={()=>setRetry(value=>value+1)}>重试</button></p>}
  {!urls&&!error&&<p role="status"><span className="gateway-spinner"/> 正在加载回调白名单…</p>}
  {urls&&(editing?<CallbackEditor urls={urls} csrf={csrf} onClose={()=>setEditing(false)} onSaved={value=>{setUrls(value);setEditing(false)}}/>
   :<>{urls.length?<ul>{urls.map(url=><li key={url}><code>{url}</code></li>)}</ul>:<p>尚未允许第三方回调地址。</p>}
    <button type="button" onClick={()=>setEditing(true)}>修改回调白名单</button></>)}
 </section>
}

function CallbackEditor({urls,csrf,onClose,onSaved}: {urls: string[];csrf: string;onClose:()=>void;onSaved:(urls:string[])=>void}) {
 const [text,setText]=useState(urls.join('\n'))
 const {password,setPassword,passwordRequired,passwordReady}=useStepUpPassword()
 const [busy,setBusy]=useState(false)
 const [error,setError]=useState('')
 const [discard,setDiscard]=useState(false)
 const submitting=useRef(false)
 const values=[...new Set(text.split('\n').map(value=>value.trim()).filter(Boolean))]
 const valid=values.length<=100&&values.every(validThirdPartyCallback)
 const changed=JSON.stringify(values)!==JSON.stringify(urls)
 async function save(){
  if(submitting.current||!valid||!changed||!passwordReady||!csrf)return
  submitting.current=true;setBusy(true);setError('')
  try{
   if(!(await confirmStepUp(csrf,password,passwordRequired)).ok)throw Error('管理员密码验证失败。')
   const response=await fetch(endpoint,{method:'PUT',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf},body:JSON.stringify({callback_urls:values})})
   if(!response.ok)throw await thirdPartyError(response,'白名单保存失败，请重试。')
   onSaved((await response.json()).callback_urls)
  }catch(reason){setError(reason instanceof Error?reason.message:'保存失败。')}
  finally{submitting.current=false;setBusy(false)}
 }
 return <div className="gateway-third-party-editor">
  <label htmlFor="third-party-callback-urls">允许的回调 URL</label>
  <textarea id="third-party-callback-urls" rows={6} value={text} disabled={busy} placeholder="http://business.example.com/login/callback" onChange={event=>setText(event.target.value)}/>
  <p>每行一个完整地址，最多 100 个。清空后关闭第三方登录授权；删除地址会使对应未兑换的 code 失效。</p>
  {!valid&&<p role="alert" className="gateway-auth-error">请填写有效的 HTTP/HTTPS 回调 URL，不含片段、用户凭据或 code、state、request_id 查询参数，且不超过 100 个。</p>}
  <PasswordConfirmation label="管理员密码" value={password} onChange={setPassword} disabled={busy}/>
  {error&&<p role="alert" className="gateway-auth-error">{error}</p>}
  {busy&&<p role="status"><span className="gateway-spinner"/> 正在保存白名单…</p>}
  <div className="gateway-dialog-actions">
   <button type="button" disabled={busy} onClick={()=>{if(changed||password)setDiscard(true);else onClose()}}>取消</button>
   <button type="button" disabled={busy||!valid||!changed||!passwordReady||!csrf} onClick={()=>void save()}>保存白名单</button>
  </div>
  {discard&&<GatewayConfirmDialog title="放弃白名单修改" message="回调白名单尚未保存。" confirmLabel="放弃并关闭" onCancel={()=>setDiscard(false)} onConfirm={onClose}/>}
 </div>
}
