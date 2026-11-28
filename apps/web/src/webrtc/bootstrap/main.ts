import { WebRtcConnectionError, type ConnectionSnapshot, type WebRtcConnectionStage } from '../connectionDiagnostics'
import { diagnosticItems, connectionFailureMessage, type DiagnosticLabels } from '../diagnosticPresentation'
declare const __WORKSTEP_RTC_MESSAGES__: { steps: Record<WebRtcConnectionStage,string>; diagnostics: DiagnosticLabels }
const rtcText=__WORKSTEP_RTC_MESSAGES__
import { connectWebRtcDirect, fetchWebRtcDeviceConfig, type WebRtcStageTiming } from '../peerClient'
import { consumeWebRtcPairingLink, loadSessionPairKey, saveSessionPairKey, validWebRtcPairKey } from '../pairingLink'
import { webrtcDeviceIdFromPath, webrtcWorkspacePath } from '../webrtcLocation'
import type {} from '../bootstrapConnection'
import './style.css'

const deviceId=webrtcDeviceIdFromPath()
const prefix=webrtcWorkspacePath()
consumeWebRtcPairingLink()
window.addEventListener('vite:preloadError',event=>{
  const url=new URL(location.href)
  if(url.searchParams.has('_workstep_reload'))return
  event.preventDefault();url.searchParams.set('_workstep_reload',String(Date.now()));location.replace(url)
})
const root=document.getElementById('root')!
root.innerHTML=`<div class="modal-overlay webrtc-pair-overlay"><section class="modal webrtc-pair-card" role="dialog" aria-modal="true" aria-labelledby="pair-title"><h1 id="pair-title">WorkStep</h1><form class="webrtc-pair-form"><label for="webrtc-remote-pair-key">配对密钥</label><div class="webrtc-secret-group"><input class="ws-input" id="webrtc-remote-pair-key" type="password" minlength="24" maxlength="128" autocomplete="off" required><button class="btn webrtc-secret-toggle" type="button" aria-label="显示密钥" aria-pressed="false"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg></button></div><ol class="webrtc-stage-list" hidden></ol><details class="webrtc-diagnostics" hidden><summary></summary><dl></dl></details><p class="webrtc-pair-error" role="alert" hidden></p><div class="webrtc-pair-footer"><button class="btn cancel" type="button">取消</button><button class="btn btn-primary" type="submit" disabled>建立直连</button></div></form></section></div>`
const input=document.querySelector<HTMLInputElement>('#webrtc-remote-pair-key')!
const submit=document.querySelector<HTMLButtonElement>('button[type=submit]')!
const error=document.querySelector<HTMLElement>('.webrtc-pair-error')!
const stages=document.querySelector<HTMLOListElement>('.webrtc-stage-list')!
const overlay=document.querySelector<HTMLElement>('.webrtc-pair-overlay')!
const viewport=()=>{overlay.style.setProperty('--app-viewport-height',`${window.visualViewport?.height||innerHeight}px`)}
viewport();window.visualViewport?.addEventListener('resize',viewport);window.addEventListener('resize',viewport)
const labels={...rtcText.steps,workspace:'加载工作台'}
const diagnosticPanel=document.querySelector<HTMLDetailsElement>('.webrtc-diagnostics')!
diagnosticPanel.querySelector('summary')!.textContent=rtcText.diagnostics.title
let diagnostics:ConnectionSnapshot|undefined
function renderDiagnostics(){
  diagnosticPanel.hidden=!diagnostics
  if(!diagnostics)return
  diagnosticPanel.querySelector('dl')!.replaceChildren(...diagnosticItems(diagnostics,rtcText.diagnostics).map(item=>{const row=document.createElement('div'),name=document.createElement('dt'),value=document.createElement('dd');name.textContent=item.label;value.textContent=item.value;row.append(name,value);return row}))
}
type Timing={stage:WebRtcStageTiming['stage']|'workspace';durationMs:number}
let abort:AbortController|undefined, timings:Timing[]=[],stageStarted=0,busy=false
let workerPrepared=false
function renderStages(){
  const names=Object.keys(labels) as (keyof typeof labels)[]
  stages.replaceChildren(...names.map(name=>{
    const item=document.createElement('li'),label=document.createElement('span'),elapsed=document.createElement('span')
    const index=timings.findIndex(stage=>stage.stage===name)
    const current=index>=0&&index===timings.length-1
    label.textContent=labels[name]
    elapsed.textContent=index<0?'—':`${((timings[index].durationMs+(busy&&current?performance.now()-stageStarted:0))/1000).toFixed(1)} 秒`
    if(current&&busy)item.setAttribute('aria-current','step')
    if(current&&!busy&&!error.hidden)item.setAttribute('data-failed','true')
    item.append(label,elapsed);return item
  }))
}
input.oninput=()=>{submit.disabled=busy||!validWebRtcPairKey(input.value.trim())}
document.querySelector<HTMLButtonElement>('.webrtc-secret-toggle')!.onclick=()=>{input.type=input.type==='password'?'text':'password';const toggle=document.querySelector<HTMLButtonElement>('.webrtc-secret-toggle')!;toggle.setAttribute('aria-pressed',String(input.type==='text'));toggle.setAttribute('aria-label',input.type==='text'?'隐藏密钥':'显示密钥')}
document.querySelector<HTMLButtonElement>('.cancel')!.onclick=()=>{abort?.abort();stages.hidden=true;error.hidden=true;diagnostics=undefined;renderDiagnostics();window.WorkStepP2p?.postMessage('settings')}

async function prepareWorker(){
  if(workerPrepared)return
  if(!('serviceWorker' in navigator))throw new Error('此浏览器不支持直连资源加载，请更新浏览器。')
  await navigator.serviceWorker.register('/p2p/rtc-worker.js',{scope:'/p2p/'})
  await navigator.serviceWorker.ready
  if(!navigator.serviceWorker.controller)await new Promise<void>(resolve=>navigator.serviceWorker.addEventListener('controllerchange',()=>resolve(),{once:true}))
  navigator.serviceWorker.addEventListener('message',event=>{
    if(event.data?.type!=='workstep:direct-resource'||!event.ports[0])return
    const port=event.ports[0],path=String(event.data.path)
    void (async()=>{
      if(!path.startsWith('/')||path.startsWith('//'))throw new Error('Invalid direct resource path')
      const connection=window.__workstepDirect?.handle
      if(!connection?.transport.isOpen)throw new Error('Direct connection closed')
      const response=await connection.transport.fetch(path)
      const body=await response.arrayBuffer()
      if(body.byteLength>64*1024*1024)throw new Error('Direct resource too large')
      const headers=Array.from(response.headers).filter(([name])=>!['content-encoding','content-length'].includes(name.toLowerCase()))
      port.postMessage({status:response.status,headers,body},[body])
    })().catch(()=>port.postMessage({status:503,body:'Direct resource unavailable'})).finally(()=>port.close())
  })
  workerPrepared=true
}

async function loadWorkspace(){
  const response=await window.__workstepDirect!.handle.transport.fetch('/')
  if(!response.ok)throw new Error(`工作台加载失败（${response.status}）`)
  const documentSource=new DOMParser().parseFromString(await response.text(),'text/html')
  const resource=(source:string)=>{
    const url=new URL(source,location.origin)
    if(url.origin!==location.origin)throw new Error('Invalid workspace resource')
    return prefix+'/__host'+url.pathname+url.search
  }
  for(const link of documentSource.querySelectorAll<HTMLLinkElement>('link[rel=stylesheet],link[rel=icon]')){
    const element=document.createElement('link');element.rel=link.rel;element.href=resource(link.getAttribute('href')!);document.head.append(element)
  }
  // The application owns the existing root; retain the peer and page URL.
  const entry=documentSource.querySelector<HTMLScriptElement>('script[type=module][src]')
  if(!entry)throw new Error('桌面端工作台资源不可用，请更新桌面端。')
  const script=document.createElement('script');script.type='module';script.src=resource(entry.getAttribute('src')!)
  await new Promise<void>((resolve,reject)=>{script.onload=()=>resolve();script.onerror=()=>reject(new Error('工作台资源加载失败，请重试。'));document.body.append(script)})
  const observer=new MutationObserver(()=>{
    if(document.querySelector('[data-webrtc-connected="true"]')){
      document.getElementById('rtc-bootstrap-style')?.remove();observer.disconnect()
      window.visualViewport?.removeEventListener('resize',viewport);window.removeEventListener('resize',viewport)
    }
  })
  observer.observe(root,{childList:true,subtree:true})
}

async function connect(){
  if(busy||!validWebRtcPairKey(input.value.trim()))return
  busy=true;submit.disabled=true;submit.setAttribute('aria-busy','true');submit.innerHTML='<span class="spinner"></span>正在建立直连…'
  error.hidden=true;stages.hidden=false;timings=[];diagnostics=undefined;diagnosticPanel.open=false;renderDiagnostics();abort=new AbortController()
  const timer=setInterval(renderStages,100)
  try{
    const handle=await connectWebRtcDirect({deviceId,pairKey:input.value.trim(),signal:abort.signal,
      onDiagnostics:snapshot=>{diagnostics=snapshot;renderDiagnostics()},
      onDeviceConfig:config=>{document.getElementById('pair-title')!.textContent=config.device_name||'WorkStep'},
      onStage:stage=>{const now=performance.now();if(timings.length)timings.at(-1)!.durationMs=now-stageStarted;stageStarted=now;timings.push({stage,durationMs:0});renderStages()}})
    saveSessionPairKey(deviceId,input.value.trim())
    window.__workstepDirect={handle,adopted:false}
    const now=performance.now();timings.at(-1)!.durationMs=now-stageStarted;stageStarted=now
    timings.push({stage:'workspace',durationMs:0});renderStages()
    submit.innerHTML='<span class="spinner"></span>正在加载工作台…'
    await prepareWorker()
    await loadWorkspace()
  }catch(cause){
    window.__workstepDirect?.handle.close();window.__workstepDirect=undefined
    if(!abort.signal.aborted){const original=cause instanceof Error?cause.message:String(cause);if(cause instanceof WebRtcConnectionError)diagnostics=cause.diagnostics;error.textContent=diagnostics?connectionFailureMessage(diagnostics,original,rtcText.diagnostics):original;error.hidden=false;diagnosticPanel.open=true;renderDiagnostics()}
  }finally{
    if(timings.length)timings.at(-1)!.durationMs+=performance.now()-stageStarted
    busy=false;clearInterval(timer);renderStages();submit.removeAttribute('aria-busy');submit.textContent='建立直连';submit.disabled=!validWebRtcPairKey(input.value.trim())
  }
}
document.querySelector<HTMLFormElement>('form')!.onsubmit=event=>{event.preventDefault();void connect()}
input.value=loadSessionPairKey(deviceId);submit.disabled=!validWebRtcPairKey(input.value.trim())
if(input.value)void connect()
else void fetchWebRtcDeviceConfig(deviceId).then(config=>{document.getElementById('pair-title')!.textContent=config.device_name||'WorkStep'}).catch(()=>undefined)
