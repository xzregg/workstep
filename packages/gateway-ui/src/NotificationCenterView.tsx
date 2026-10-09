import { notifyAndroidGatewayCompletion } from './androidNotifications'
import * as React from 'react'

export type GatewayNotice = {sequence:number;id:string;device_id:string;device_name:string;host_project_id:string;
  project_name:string;messageId?:string;source_sequence?:number;scope_name?:string;task_id?:string;session_id?:string;step_key?:string;status:string;occurred_at:number;read:boolean}
type Snapshot = {events:GatewayNotice[];unread:number;cursor:number;more:boolean}
export type NotificationTarget = {sequence:number;device_id:string;project_id?:string}

export function NotificationCenterView({onOpen}: {onOpen:(target:NotificationTarget,access:{url:string;ticket:string;next?:string})=>void}) {
  const [snapshot,setSnapshot]=React.useState<Snapshot>({events:[],unread:0,cursor:0,more:false})
  const [open,setOpen]=React.useState(false)
  const [connected,setConnected]=React.useState(false)
  const [error,setError]=React.useState('')
  const [busy,setBusy]=React.useState(false)
  const pending=React.useRef(false)
  const root=React.useRef<HTMLDivElement>(null)
  const current=React.useRef(snapshot)
  React.useEffect(()=>{current.current=snapshot},[snapshot])
  React.useEffect(()=>{
    let active=true
    let socket:WebSocket|undefined
    let retry:ReturnType<typeof setTimeout>
    let heartbeat:ReturnType<typeof setInterval>
    let lastSeen=0
    let nativeCursor:number|undefined
    const startedAt=Date.now()/1000
    let delay=1000
    function connect() {
      if(!active || typeof WebSocket==='undefined')return
      const connection=new WebSocket(`${window.location.protocol==='https:'?'wss':'ws'}://${window.location.host}/ws/notifications`)
      socket=connection
      connection.onerror=()=>{ /* onclose schedules bounded reconnect. */ }
      connection.onopen=()=>{if(socket!==connection||!active)return;delay=1000;lastSeen=Date.now();setConnected(true)}
      connection.onmessage=event=>{
        if(socket!==connection||!active)return
        lastSeen=Date.now()
        try {
          const next=JSON.parse(event.data)
          if(next.type==='notifications' && Array.isArray(next.events)) {
            for(const notice of next.events as GatewayNotice[]) {
              if(nativeCursor===undefined?notice.occurred_at>=startedAt:notice.sequence>nativeCursor)notifyAndroidGatewayCompletion(notice)
            }
            nativeCursor=Math.max(nativeCursor ?? 0,next.cursor ?? 0)
            setSnapshot(next);setError('')
          }
        } catch { /* Ignore malformed transport messages. */ }
      }
      connection.onclose=event=>{
        if(socket!==connection||!active)return
        socket=undefined
        setConnected(false);clearInterval(heartbeat)
        if(!active || [4401,4403].includes(event.code))return
        retry=setTimeout(connect,delay+Math.random()*500);delay=Math.min(delay*2,30000)
      }
      heartbeat=setInterval(()=>{
        if(connection.readyState!==1)return
        if(Date.now()-lastSeen>35000)connection.close()
        else connection.send(JSON.stringify({type:'ping'}))
      },15000)
    }
    // Initial HTTP load also works in environments without WebSocket support.
    const controller=new AbortController()
    void fetch('/api/notifications',{credentials:'same-origin',signal:controller.signal}).then(async response=>{
      if(!response.ok)throw Error('通知加载失败，请刷新重试。')
      const data=await response.json()
      if(active && Array.isArray(data.events) && !lastSeen)setSnapshot(data)
    }).catch(reason=>{if(active && reason.name!=='AbortError')setError(reason.message)})
    connect()
    function resume(){if(active && (!socket || socket.readyState>1)){clearTimeout(retry);clearInterval(heartbeat);connect()}}
    window.addEventListener('online',resume)
    return()=>{active=false;controller.abort();clearTimeout(retry);clearInterval(heartbeat);socket?.close();window.removeEventListener('online',resume)}
  },[])
  React.useEffect(()=>{
    if(!open)return
    function dismiss(event:Event){if(event.type==='keydown'?(event as KeyboardEvent).key==='Escape':!root.current?.contains(event.target as Node))setOpen(false)}
    document.addEventListener('keydown',dismiss);document.addEventListener('pointerdown',dismiss)
    return()=>{document.removeEventListener('keydown',dismiss);document.removeEventListener('pointerdown',dismiss)}
  },[open])

  async function markRead() {
    if(pending.current)return
    pending.current=true;setBusy(true)
    try {
      const session=await fetch('/api/auth/session',{credentials:'same-origin'})
      if(!session.ok)throw Error('登录已失效，请重新登录。')
      const {csrf_token}=await session.json()
      const through=current.current.cursor
      const response=await fetch('/api/notifications/read',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-CSRF-Token':csrf_token},body:JSON.stringify({through})})
      if(!response.ok)throw Error('标记已读失败，请重试。')
      setSnapshot(previous=>({...previous,unread:previous.events.filter(e=>e.sequence>through&&!e.read).length,
        events:previous.events.map(e=>e.sequence<=through?{...e,read:true}:e)}))
      setError('')
    } catch(reason){setError(reason instanceof Error?reason.message:'操作失败。')}
    finally{pending.current=false;setBusy(false)}
  }
  async function choose(notice:GatewayNotice) {
    if(pending.current)return
    pending.current=true;setBusy(true);setError('')
    try {
      const response=await fetch(`/api/notifications/${notice.sequence}/access`,{credentials:'same-origin'})
      if(!response.ok)throw Error(response.status===409?'设备离线，通知已保留，上线后可重试。':'通知访问权限已变化，请刷新重试。')
      const access=await response.json()
      const target:NotificationTarget={sequence:notice.sequence,device_id:notice.device_id,project_id:access.project_id}
      onOpen(target,access)
      setOpen(false)
    } catch(reason){setError(reason instanceof Error?reason.message:'打开通知失败。')}
    finally{pending.current=false;setBusy(false)}
  }
  async function older() {
    if(pending.current || !snapshot.events.length)return
    pending.current=true;setBusy(true)
    try {
      const before=Math.min(...snapshot.events.map(e=>e.sequence))
      const response=await fetch('/api/notifications?before='+before,{credentials:'same-origin'})
      if(!response.ok)throw Error('通知加载失败，请重试。')
      const next:Snapshot=await response.json()
      setSnapshot(previous=>({...previous,more:next.more,events:[...previous.events,...next.events.filter(e=>!previous.events.some(item=>item.id===e.id))]}))
    } catch(reason){setError(reason instanceof Error?reason.message:'加载失败。')}
    finally{pending.current=false;setBusy(false)}
  }
  return <div className="gateway-notifications" ref={root}>
    <button type="button" className="gateway-notification-trigger" aria-label={`通知，${snapshot.unread} 条未读`} aria-expanded={open} onClick={()=>setOpen(value=>!value)}>
      <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4"/></svg>
      {snapshot.unread>0 && <span>{snapshot.unread>99?'99+':snapshot.unread}</span>}
    </button>
    {open && <section className="gateway-notification-panel" aria-label="跨设备通知">
      <header><div><strong>通知</strong><small>{connected?'跨设备汇总':'连接恢复中，已保存通知仍可查看'}</small></div>
        <button type="button" disabled={busy||!snapshot.unread} onClick={()=>void markRead()}>全部已读</button>
        <button type="button" aria-label="关闭通知" onClick={()=>setOpen(false)}>×</button></header>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status"><span className="gateway-spinner"/> 正在处理…</p>}
      <ul>{snapshot.events.map(notice=><li key={notice.id} className={notice.read?'':'gateway-notification-unread'}>
        <button type="button" disabled={busy} onClick={()=>void choose(notice)}>
          <strong>{notice.scope_name || (notice.task_id?'任务 '+notice.task_id:'对话 '+notice.session_id)} · {['passed','succeeded'].includes(notice.status)?'已完成':'失败'}</strong>
          <span>{notice.device_name} · {notice.project_name}{notice.step_key?' · 步骤 '+notice.step_key:''}</span>
          <time dateTime={new Date(notice.occurred_at*1000).toISOString()}>{new Date(notice.occurred_at*1000).toLocaleString()}</time>
        </button></li>)}</ul>
      {!snapshot.events.length && <p className="gateway-notification-empty">暂无通知，设备完成任务后会显示在这里。</p>}
      {snapshot.more && <button type="button" disabled={busy} onClick={()=>void older()}>加载更早通知</button>}
    </section>}
  </div>
}
