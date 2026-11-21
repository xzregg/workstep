import { localizeGatewayError } from './gatewayErrorText'
import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { thirdPartyError, thirdPartyRequest, validIssuedCallback } from './thirdPartyAuth'

const goToCallback=(url: string)=>window.location.assign(url)

export function ThirdPartyAuthorizePage({onAuthorized=goToCallback}: {onAuthorized?: (url: string)=>void}) {
 const {pathname,search}=useLocation()
 const navigate=useNavigate()
 const [error,setError]=useState('')
 const [retry,setRetry]=useState(0)
 useEffect(()=>{
  const controller=new AbortController()
  setError('')
  async function start(){
   try{
    const request=thirdPartyRequest(new URLSearchParams(search))
    if(!request)throw Error('Invalid login link parameters. Please initiate login again from the third-party system.')
    const options={method:'POST',credentials:'same-origin' as const,signal:controller.signal,
     headers:{'Content-Type':'application/json'},body:JSON.stringify(request)}
    const validated=await fetch('/api/auth/third-party/validate',options)
    if(!validated.ok)throw await thirdPartyError(validated,'回调地址未获授权，请联系管理员。')
    if(controller.signal.aborted)return
    const session=await fetch('/api/auth/session',{credentials:'same-origin',signal:controller.signal})
    if(controller.signal.aborted)return
    if(session.status===401){navigate('/auth?next='+encodeURIComponent(pathname+search),{replace:true});return}
    if(!session.ok)throw Error('Login status check failed, please try again.')
    const auth=await session.json()
    if(!auth.csrf_token)throw Error('Your session has expired. Sign in again.')
    if(controller.signal.aborted)return
    const result=await fetch('/api/auth/third-party/authorize',{...options,headers:{...options.headers,'X-CSRF-Token':auth.csrf_token}})
    if(!result.ok)throw await thirdPartyError(result,'授权失败，请重试。')
    const body=await result.json()
    if(typeof body.callback_url!=='string' || !validIssuedCallback(body.callback_url,request))throw Error('The callback address returned by the gateway is invalid. Please re-initiate login.')
    if(!controller.signal.aborted)onAuthorized(body.callback_url)
   }catch(reason){if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'Authorization failed, please try again.')}
  }
  void start()
  return ()=>controller.abort()
 },[pathname,search,navigate,onAuthorized,retry])
 return <section className="gateway-auth-card">
  <span className="gateway-auth-eyebrow">WORKSTEP 平台</span>
  <h2>第三方登录</h2>
  {error?<><p className="gateway-auth-error" role="alert">{localizeGatewayError(error)}</p><button type="button" onClick={()=>setRetry(value=>value+1)}>重试</button></>
   :<p role="status"><span className="gateway-spinner"/> 正在验证登录并返回第三方系统…</p>}
 </section>
}
