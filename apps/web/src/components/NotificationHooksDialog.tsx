import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { notificationHooksApi, notificationEvents, type NotificationConfiguration, type NotificationEvent, type NotificationHook, type NotificationPreview, type NotificationRecord } from '../api/notificationHooks'
import { useI18n } from '../i18n'
import { useOverlay } from '../hooks/useOverlay'
import { useCompactLayout } from '../hooks/useCompactLayout'
import Button from './Button'
import ConfirmDialog from './ConfirmDialog'
import Icon from './Icon'
import ResizablePanel from './ResizablePanel'
import MarkdownMessage from './MarkdownMessage'
import WorkflowHookTypeTabs from './WorkflowHookTypeTabs'
import './WorkflowHooksDialog.css'
import './NotificationHooksDialog.css'

interface Props { projectId:string;workflowId:string;workflowName:string;onClose:()=>void;onSwitchType:()=>void }
export default function NotificationHooksDialog({projectId,workflowId,workflowName,onClose,onSwitchType}:Props) {
  const { t }=useI18n()
  const [config,setConfig]=useState<NotificationConfiguration|null>(null)
  const [hooks,setHooks]=useState<NotificationHook[]>([])
  const [initial,setInitial]=useState('[]')
  const [selected,setSelected]=useState(0)
  const [tab,setTab]=useState<'config'|'preview'|'history'>('config')
  const [busy,setBusy]=useState('load')
  const [notice,setNotice]=useState('')
  const [failed,setFailed]=useState(false)
  const [reload,setReload]=useState(0)
  const [confirm,setConfirm]=useState<''|'close'|'switch'|'delete'|'test'>('')
  const [showUrl,setShowUrl]=useState(false)
  const [sample,setSample]=useState({event:'completed' as NotificationEvent,title:'',step:''})
  const [preview,setPreview]=useState<NotificationPreview|null>(null)
  const [history,setHistory]=useState({items:[] as NotificationRecord[],offset:0,revision:0,loading:false,error:''})
  const hook=hooks[selected],dirty=JSON.stringify(hooks)!==initial
  const invalid=hooks.some(h=>!h.name.trim()||!/^https?:\/\/\S+$/.test(h.url)||!h.events.length)
  const ready=!!hook?.id&&!dirty
  const dialogRef=useRef<HTMLDivElement>(null)
  const compact=useCompactLayout()
  const close=()=>{if(busy)return;if(dirty)setConfirm('close');else onClose()}
  useOverlay(true,close,dialogRef,compact)
  const errorText=(error:unknown)=>error instanceof Error?error.message:String(error)
  const eventLabel=(event:NotificationEvent|'test')=>t(`notificationHooks.events.${event}`)
  const platformLabel=(platform:NotificationHook['platform'])=>t(`notificationHooks.platforms.${platform}`)

  useEffect(()=>{
    let cancelled=false
    setBusy('load');setFailed(false)
    void notificationHooksApi.get(projectId,workflowId).then(data=>{
      if(cancelled)return
      setConfig(data);setHooks(data.hooks);setInitial(JSON.stringify(data.hooks));setSelected(0);setNotice('')
    }).catch(error=>{if(!cancelled){setFailed(true);setNotice(errorText(error))}}).finally(()=>{if(!cancelled)setBusy('')})
    return()=>{cancelled=true}
  },[projectId,workflowId,reload])

  useEffect(()=>{
    if(tab!=='history'||!hook?.id)return
    let cancelled=false,timer:ReturnType<typeof setTimeout>|undefined
    setHistory(h=>({...h,loading:true,error:''}))
    void notificationHooksApi.records(projectId,workflowId,hook.id,history.offset).then(data=>{
      if(cancelled)return
      setHistory(h=>({...h,items:data.deliveries}))
      if(data.deliveries.some(r=>r.status==='pending'||r.status==='sending'))timer=setTimeout(()=>setHistory(h=>({...h,revision:h.revision+1})),2000)
    }).catch(error=>{if(!cancelled)setHistory(h=>({...h,error:errorText(error)}))}).finally(()=>{if(!cancelled)setHistory(h=>({...h,loading:false}))})
    return()=>{cancelled=true;clearTimeout(timer)}
  },[projectId,workflowId,hook?.id,tab,history.offset,history.revision])

  const change=(patch:Partial<NotificationHook>)=>{setHooks(all=>all.map((h,i)=>i===selected?{...h,...patch}:h));setPreview(null);setNotice('')}
  const choose=(index:number)=>{setSelected(index);setShowUrl(false);setPreview(null);setHistory(h=>({...h,items:[],offset:0,error:''}))}
  const save=async()=>{
    if(busy||invalid||!config||failed)return
    setBusy('save');setNotice('')
    try {const data=await notificationHooksApi.save(projectId,workflowId,hooks);setConfig(data);setHooks(data.hooks);setInitial(JSON.stringify(data.hooks));setNotice(t('notificationHooks.saved'))}
    catch(error){setNotice(errorText(error))}finally{setBusy('')}
  }
  const generatePreview=async()=>{
    if(!hook||invalid||busy)return
    setBusy('preview');setNotice('')
    try {setPreview(await notificationHooksApi.preview(projectId,workflowId,hook,sample.event,sample.title.trim()||t('notificationHooks.sampleTitle'),sample.step.trim()||t('notificationHooks.sampleStep')))}
    catch(error){setNotice(errorText(error))}finally{setBusy('')}
  }
  const sendTest=async()=>{
    if(!ready||!hook?.id||!hook.enabled||busy)return
    setBusy('test');setNotice('')
    try {await notificationHooksApi.test(projectId,workflowId,hook.id);setNotice(t('notificationHooks.queued'));setHistory(h=>({...h,revision:h.revision+1}))}
    catch(error){setNotice(errorText(error))}finally{setBusy('')}
  }
  const retry=async(id:string)=>{
    if(!hook?.id||busy)return
    setBusy('retry');setNotice('')
    try {await notificationHooksApi.retry(projectId,workflowId,hook.id,id);setHistory(h=>({...h,revision:h.revision+1}));setNotice(t('notificationHooks.queued'))}
    catch(error){setNotice(errorText(error))}finally{setBusy('')}
  }
  const confirmAction=()=>{
    if(confirm==='close')onClose()
    if(confirm==='switch')onSwitchType()
    if(confirm==='delete'){setHooks(all=>all.filter((_,i)=>i!==selected));choose(Math.max(0,selected-1))}
    if(confirm==='test')void sendTest()
    setConfirm('')
  }
  const switchType=()=>{if(busy)return;if(dirty)setConfirm('switch');else onSwitchType()}
  const payload=preview?.payload as {markdown?:{text?:string;content?:string}}|undefined
  const message=payload?.markdown?.text||payload?.markdown?.content
  return createPortal(<div className="workflow-hooks-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)close()}}>
    <ResizablePanel ref={dialogRef} className="workflow-hooks-dialog" role="dialog" aria-modal="true" aria-label={t('notificationHooks.notification')} minWidth={650} minHeight={480}>
      <header className="workflow-hooks-header"><strong>{t('workflowHooks.title')} · {workflowName}</strong><Button onClick={close} disabled={!!busy}>{t('workflowHooks.close')}</Button></header>
      <WorkflowHookTypeTabs kind="notification" onSwitch={switchType} disabled={!!busy}/>
      <nav className="workflow-hooks-tabs" role="tablist">{(['config','preview','history'] as const).map(key=><button key={key} role="tab" aria-selected={tab===key} onClick={()=>setTab(key)}>{t(`notificationHooks.tabs.${key}`)}</button>)}</nav>
      <div className="workflow-hooks-content">
        {!!busy&&<div className="workflow-hooks-loading"><Icon name="loader-circle" size={20} className="git-spin"/>{t('workflowHooks.processing')}</div>}
        {failed&&<Button onClick={()=>setReload(n=>n+1)}>{t('workflowHooks.retry')}</Button>}
        {config&&!failed&&<div className="workflow-hooks-layout"><aside className="workflow-hooks-list">
          {hooks.map((h,i)=><button key={h.id||`draft-${i}`} className={i===selected?'active':''} onClick={()=>choose(i)} disabled={!!busy}><strong>{h.name||t('workflowHooks.unnamed')}</strong><small>{platformLabel(h.platform)} · {t(h.enabled?'workflowHooks.enabled':'workflowHooks.disabled')}</small></button>)}
          <Button disabled={!!busy||hooks.length>=100} onClick={()=>{setHooks(all=>[...all,{name:t('notificationHooks.newHook'),platform:'generic',url:'',secret:'',enabled:true,events:['completed','failed'],prefix:'',include_link:true,link_base:config.addresses[0]?.kind||'gateway'}]);choose(hooks.length);setTab('config')}}>{t('notificationHooks.add')}</Button>
        </aside>{!hook?<p className="notification-hooks-empty">{t('workflowHooks.empty')}</p>:<div className="notification-hooks-main">
          {tab==='config'&&<fieldset className="workflow-hooks-editor notification-hooks-columns" disabled={!!busy}>
            <div><label>{t('workflowHooks.name')}<input value={hook.name} maxLength={128} onChange={e=>change({name:e.target.value})}/></label>
              <label className="workflow-hooks-checkbox"><input type="checkbox" checked={hook.enabled} onChange={e=>change({enabled:e.target.checked})}/>{t('workflowHooks.enabled')}</label>
              <label>{t('notificationHooks.platform')}<select value={hook.platform} onChange={e=>change({platform:e.target.value as NotificationHook['platform'],secret:''})}>{(['dingtalk','wecom','generic'] as const).map(p=><option key={p} value={p}>{platformLabel(p)}</option>)}</select></label>
              <label>{t('notificationHooks.url')}<input data-testid="notification-url" type={showUrl?'text':'password'} autoComplete="off" value={hook.url} maxLength={4096} onChange={e=>change({url:e.target.value})}/></label>
              <Button onClick={()=>setShowUrl(v=>!v)}>{t(showUrl?'workflowHooks.hide':'workflowHooks.show')}</Button><p className="workflow-hooks-hint">{t('notificationHooks.urlHint')}</p>
              {hook.platform==='dingtalk'&&<label>{t('notificationHooks.secret')}<input type="password" autoComplete="off" value={hook.secret} maxLength={1024} onChange={e=>change({secret:e.target.value})}/></label>}
              <h3>{t('notificationHooks.delivery')}</h3><p className="workflow-hooks-hint">{t('notificationHooks.deliveryHint')}</p>
              <Button onClick={()=>setConfirm('delete')}>{t('workflowHooks.delete')}</Button>
            </div><div><h3>{t('notificationHooks.subscribe')}</h3><p className="workflow-hooks-hint">{t('notificationHooks.eventHint')}</p>
              {notificationEvents.map(event=><label className="workflow-hooks-checkbox" key={event}><input type="checkbox" checked={hook.events.includes(event)} onChange={e=>change({events:e.target.checked?[...hook.events,event]:hook.events.filter(k=>k!==event)})}/>{eventLabel(event)}</label>)}
              <h3>{t('notificationHooks.content')}</h3><label>{t('notificationHooks.prefix')}<input value={hook.prefix} maxLength={80} onChange={e=>change({prefix:e.target.value})}/></label>
              <label className="workflow-hooks-checkbox"><input type="checkbox" checked={hook.include_link} onChange={e=>change({include_link:e.target.checked})}/>{t('notificationHooks.includeLink')}</label>
              <label>{t('notificationHooks.linkBase')}<select value={hook.link_base} disabled={!hook.include_link} onChange={e=>change({link_base:e.target.value as NotificationHook['link_base']})}>{config.addresses.map(a=><option value={a.kind} key={a.kind}>{t(`workflowHooks.${a.kind}`)}</option>)}{!config.addresses.some(a=>a.kind===hook.link_base)&&<option value={hook.link_base}>{t(`workflowHooks.${hook.link_base}`)} · {t('notificationHooks.missingAddress')}</option>}</select></label>
              <p className="workflow-hooks-hint">{t('notificationHooks.contentHint')}</p><div className="notification-hooks-note">{t('notificationHooks.retryHint')}</div>
            </div>
          </fieldset>}
          {tab==='preview'&&<div className="workflow-hooks-simulation"><div className="workflow-hooks-fields">
            <label>{t('notificationHooks.event')}<select value={sample.event} onChange={e=>{setSample(s=>({...s,event:e.target.value as NotificationEvent}));setPreview(null)}}>{notificationEvents.map(event=><option value={event} key={event}>{eventLabel(event)}</option>)}</select></label>
            <label>{t('notificationHooks.taskTitle')}<input value={sample.title} maxLength={500} placeholder={t('notificationHooks.sampleTitle')} onChange={e=>{setSample(s=>({...s,title:e.target.value}));setPreview(null)}}/></label>
            <label>{t('notificationHooks.step')}<input value={sample.step} maxLength={128} placeholder={t('notificationHooks.sampleStep')} onChange={e=>{setSample(s=>({...s,step:e.target.value}));setPreview(null)}}/></label>
          </div><p className="workflow-hooks-hint">{t('notificationHooks.previewHint')}</p><div className="notification-hooks-actions"><Button onClick={()=>void generatePreview()} disabled={!!busy||invalid}>{t('notificationHooks.generate')}</Button><Button variant="primary" onClick={()=>setConfirm('test')} disabled={!!busy||!ready||!hook.enabled}>{t('notificationHooks.test')}</Button></div>
            {!ready&&<p className="workflow-hooks-hint">{t('notificationHooks.saveFirst')}</p>}
            {preview&&<section className="workflow-hooks-preview"><h3>{platformLabel(hook.platform)} · {t('notificationHooks.preview')}</h3>{!message&&<strong>{preview.snapshot.task.title}</strong>}{!preview.subscribed&&<p className="workflow-hooks-hint">{t('notificationHooks.unsubscribed')}</p>}{message&&<div className="notification-hooks-message"><MarkdownMessage content={message} reveal="off"/></div>}<h3>{t('notificationHooks.payload')}</h3><pre>{JSON.stringify(preview.payload,null,2)}</pre></section>}
          </div>}
          {tab==='history'&&<div className="notification-hooks-history"><div className="notification-hooks-actions"><h3>{t('notificationHooks.tabs.history')}</h3><Button disabled={history.loading} onClick={()=>setHistory(h=>({...h,revision:h.revision+1}))}>{t('notificationHooks.refresh')}</Button></div>
            {!hook.id?<p>{t('notificationHooks.saveFirst')}</p>:<><div className="notification-hooks-table"><table><thead><tr>{(['time','taskTitle','event','state','attempts','result','action'] as const).map(key=><th key={key}>{t(`notificationHooks.${key}`)}</th>)}</tr></thead><tbody>{history.items.map(record=><tr key={record.id}><td>{new Date(record.created_at*1000).toLocaleString()}</td><td>{record.title}</td><td>{eventLabel(record.event)}</td><td><span className={`notification-hook-state notification-hook-state--${record.status}`}>{(record.status==='pending'||record.status==='sending')&&<Icon name="loader-circle" size={12} className="git-spin"/>}{t(`notificationHooks.states.${record.status}`)}</span></td><td>{record.attempts}</td><td>{record.result||'—'}</td><td>{record.status==='failed'&&<Button disabled={!!busy||!ready||!hook.enabled} onClick={()=>void retry(record.id)}>{t('notificationHooks.retry')}</Button>}</td></tr>)}</tbody></table></div>
              {history.loading&&<div className="workflow-hooks-loading"><Icon name="loader-circle" size={16} className="git-spin"/>{t('workflowHooks.processing')}</div>}
              {history.error&&<p role="alert">{history.error}</p>}{!history.loading&&!history.error&&!history.items.length&&<p>{t('notificationHooks.noRecords')}</p>}
              <div className="notification-hooks-actions"><Button disabled={history.loading||history.offset===0} onClick={()=>setHistory(h=>({...h,offset:Math.max(0,h.offset-50)}))}>{t('notificationHooks.previous')}</Button><Button disabled={history.loading||history.items.length<50} onClick={()=>setHistory(h=>({...h,offset:h.offset+50}))}>{t('notificationHooks.next')}</Button></div></>}
          </div>}
        </div>}</div>}
      </div>
      <footer className="workflow-hooks-footer"><span role="status">{notice||(invalid?t('notificationHooks.required'):'')}</span>{tab==='config'&&<Button variant="primary" disabled={!!busy||failed||!config||invalid||!dirty} onClick={()=>void save()}>{t('workflowHooks.save')}</Button>}</footer>
    </ResizablePanel>
    <ConfirmDialog open={!!confirm} title={t('notificationHooks.notification')} message={t(confirm==='test'?'notificationHooks.testConfirm':confirm==='delete'?'notificationHooks.deleteConfirm':'workflowHooks.unsaved')} confirmText={t(confirm==='test'?'notificationHooks.confirmSend':'workflowHooks.confirm')} onCancel={()=>setConfirm('')} onConfirm={confirmAction}/>
  </div>,document.body)
}
