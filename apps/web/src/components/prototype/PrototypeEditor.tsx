import { useEffect, useRef, useState, type CSSProperties, type PointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { prototypeApi, type PrototypeState, type PrototypeDocument, type PrototypeSelection } from '../../api/prototype'
import { fsApi } from '../../api/client'
import { useI18n } from '../../i18n'
import { HTML_PREVIEW_SANDBOX } from '../../utils/htmlPreviewCompat'
import { randomUuid } from '../../utils/uuid'
import Button from '../Button'
import Icon from '../Icon'
import { useOverlay } from '../../hooks/useOverlay'
import { useCompactLayout } from '../../hooks/useCompactLayout'
import ResizablePanel from '../ResizablePanel'
import ConfirmDialog from '../ConfirmDialog'
import PrototypeChat from './PrototypeChat'
import PrototypeInspector from './PrototypeInspector'
import PrototypeFiles from './PrototypeFiles'
import PrototypeHistory from './PrototypeHistory'
import './PrototypeEditor.css'

export default function PrototypeEditor({projectId,path:entry,onClose}:{projectId:string;path:string;onClose:()=>void}) {
  const {t}=useI18n()
  const panelRef=useRef<HTMLDivElement>(null)
  const compact=useCompactLayout()
  const [work,setWork]=useState<PrototypeState|null>(null),[path,setPath]=useState(''),[document,setDocument]=useState<PrototypeDocument|null>(null)
  const [selection,setSelection]=useState<PrototypeSelection|null>(null),[hover,setHover]=useState<PrototypeSelection|null>(null)
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[mode,setMode]=useState(true)
  const [layout,setLayout]=useState({tree:false,showChat:true,showProps:true,left:320,right:260,maximized:false,history:false,mobileTab:'preview',dragging:false,viewport:'desktop',zoom:100})
  const {tree,showChat,showProps,left,right,maximized,history,mobileTab,viewport,zoom}=layout
  const changeLayout=<K extends keyof typeof layout>(key:K,value:typeof layout[K])=>setLayout(previous=>({...previous,[key]:value}))
  const [comment,setComment]=useState(''),[commentTarget,setCommentTarget]=useState<PrototypeSelection|null>(null)
  const [outgoing,setOutgoing]=useState<{text:string;key:string}|null>(null),[confirm,setConfirm]=useState<'close'|'delete'|'discard'|null>(null)
  const documentRequest=useRef(0), mutationEpoch=useRef(0)
  const frame=useRef<HTMLIFrameElement>(null),current=useRef({path,document,mode,work,busy})
  current.current={path,document,mode,work,busy}
  const api=prototypeApi(projectId,work?.id)
  const locked=busy||Boolean(work&&work.status!=='idle')
  const sendMode=()=>frame.current?.contentWindow?.postMessage({source:'workstep-prototype-host',type:'mode',enabled:current.current.mode,accent:getComputedStyle(window.document.documentElement).getPropertyValue('--accent').trim()},'*')
  useEffect(()=>{let active=true;prototypeApi(projectId).open(entry).then(value=>{if(active){setWork(value);setPath(value.path||'')}}).catch(e=>active&&setError(String(e)));return()=>{active=false}},[projectId,entry])
  const reload=async()=>{
    const state=current.current;if(!state.work||!state.path)return
    const requestId=++documentRequest.current
    const result=await prototypeApi(projectId,state.work.id).document(state.path,state.mode)
    if(requestId===documentRequest.current&&current.current.path===state.path&&current.current.mode===state.mode){setDocument(result);setSelection(null);setHover(null);setCommentTarget(null)}
  }
  useEffect(()=>{let active=true;const requestId=++documentRequest.current;setDocument(null);setSelection(null);setHover(null);setCommentTarget(null)
    if(work&&path)api.document(path,mode).then(value=>active&&requestId===documentRequest.current&&setDocument(value)).catch(e=>active&&setError(String(e)))
    return()=>{active=false}
  },[projectId,work?.id,path,mode])
  useEffect(()=>{sendMode()},[mode])
  useEffect(()=>{
    if(!work)return
    let stopped=false,timer:ReturnType<typeof setTimeout>
    const poll=async()=>{const epoch=mutationEpoch.current;try{if(current.current.busy)return;const value=await api.state();if(stopped||current.current.busy||epoch!==mutationEpoch.current)return
      const previous=current.current.work
      setWork(value)
      if(previous&&(previous.status!==value.status||previous.history.at(-1)?.id!==value.history.at(-1)?.id))await reload()
    }catch(e){if(!stopped)setError(String(e))}finally{if(!stopped)timer=setTimeout(poll,1800)}}
    timer=setTimeout(poll,1800);return()=>{stopped=true;clearTimeout(timer)}
  },[projectId,work?.id])
  const edit=async(node:string,operation:string,values:Record<string,string>,version:string)=>{
    const state=current.current;if(!state.work||state.busy||state.work.status!=='idle')return
    mutationEpoch.current++;current.current.busy=true;setBusy(true);setError('')
    try{const value=await prototypeApi(projectId,state.work.id).edit(state.path,node,operation,values,version);setWork(value);await reload()}
    catch(e){setError(String(e))}finally{current.current.busy=false;setBusy(false)}
  }
  useEffect(()=>{
    const listener=(event:MessageEvent)=>{
      if(event.source!==frame.current?.contentWindow||event.data?.source!=='workstep-prototype')return
      const data=event.data,state=current.current
      if(data.type==='ready'){sendMode();return}
      if(!state.mode||!state.document||data.version!==state.document.version)return
      if((data.type==='select'||data.type==='hover'||data.type==='delete-request')&&data.selection&&typeof data.selection.tag==='string'&&typeof data.selection.text==='string'){
        const chosen={...data.selection,version:data.version} as PrototypeSelection
        if(data.type==='hover'){setHover(chosen);return}
        setSelection(chosen)
        if(data.comment){setCommentTarget(chosen);setHover(null)}
        if(data.type==='delete-request'&&chosen.node_id&&state.document.nodes[chosen.node_id]?.editable)setConfirm('delete')
      }
      if(data.type==='clear'){setSelection(null);setCommentTarget(null);setHover(null)}
      if(data.type==='edit'&&typeof data.node_id==='string'&&['text','style'].includes(data.operation)&&data.values&&state.document.nodes[data.node_id]?.editable){
        void edit(data.node_id,data.operation,data.values,data.version)
      }
    }
    window.addEventListener('message',listener);return()=>window.removeEventListener('message',listener)
  },[projectId])
  const action=async(name:string)=>{mutationEpoch.current++;setBusy(true);setError('');try{setWork(await api.action(name));await reload()}catch(e){setError(String(e))}finally{setBusy(false)}}
  useEffect(()=>{
    if(!layout.dragging)return
    const stop=()=>changeLayout('dragging',false)
    window.addEventListener('pointerup',stop);window.addEventListener('pointercancel',stop)
    return()=>{window.removeEventListener('pointerup',stop);window.removeEventListener('pointercancel',stop)}
  },[layout.dragging])
  const resize=(side:'left'|'right',event:PointerEvent<HTMLDivElement>)=>{
    event.preventDefault();event.stopPropagation()
    const start=event.clientX,initial=side==='left'?left:right,target=event.currentTarget
    target.setPointerCapture(event.pointerId)
    const move=(e:globalThis.PointerEvent)=>{const next=Math.max(side==='left'?260:220,Math.min(520,initial+(e.clientX-start)*(side==='left'?1:-1)));side==='left'?changeLayout('left',next):changeLayout('right',next)}
    const stop=()=>{target.removeEventListener('pointermove',move);target.removeEventListener('pointerup',stop);target.removeEventListener('pointercancel',stop)}
    target.addEventListener('pointermove',move);target.addEventListener('pointerup',stop);target.addEventListener('pointercancel',stop)
  }
  const target=commentTarget||hover
  const previewScale=zoom/100
  const frameBounds=frame.current?.getBoundingClientRect()
  const frameWrap=frame.current?.closest('.prototype-frame-wrap')
  const wrapBounds=frameWrap?.getBoundingClientRect()
  const commentLeft=(frameBounds?.left||0)-(wrapBounds?.left||0)+(frameWrap?.scrollLeft||0)+(target?.rect.x||0)*previewScale
  const commentTop=(frameBounds?.top||0)-(wrapBounds?.top||0)+(frameWrap?.scrollTop||0)+((target?.rect.y||0)+(target?.rect.height||0))*previewScale
  const close=()=>comment.trim()?setConfirm('close'):onClose()
  useOverlay(true,close,panelRef,compact)
  return createPortal(<div className="prototype-backdrop">
    <ResizablePanel ref={panelRef} role="dialog" aria-modal="true" aria-label={t('prototype.title')} tabIndex={-1} className={`prototype-editor${maximized?' prototype-editor--maximized':''}${layout.dragging?' prototype-editor--dragging':''}`} onPointerDownCapture={event=>{if((event.target as HTMLElement).closest('.prototype-divider,.resizable-panel-handle'))changeLayout('dragging',true)}} minWidth={760} minHeight={480} onClick={event=>event.stopPropagation()}>
      <header className="prototype-header">
        <Icon name="file" size={20}/><strong>{t('prototype.title')}</strong>
        <Button className="prototype-file" title={path||entry} aria-expanded={tree} onClick={()=>changeLayout('tree',!tree)}><span>{path.split('/').at(-1)||entry}</span><Icon name="chevron-down" size={12}/></Button>
        <span className={busy||work?.status==='running'?'prototype-status prototype-status--busy':'prototype-status'}>{busy?t('prototype.saving'):work?.status==='idle'?t('prototype.saved'):work?t(`prototype.${work.status}` as 'prototype.running'):''}</span>
        <div className="prototype-window-actions">
          <Button className="prototype-header-action" disabled={locked||!work?.history.length} onClick={()=>void action('undo')}><Icon name="undo-2"/>{t('prototype.undo')}</Button>
          <Button className="prototype-header-action" aria-pressed={history} onClick={()=>changeLayout('history',!history)}><Icon name="clock"/>{t('prototype.history')}</Button>
          <span className="prototype-toolbar-rule"/>
          <Button variant="icon" className="prototype-icon-button" title={t('prototype.chat')} aria-label={t('prototype.chat')} aria-pressed={showChat} onClick={()=>changeLayout('showChat',!showChat)}><Icon name="panel-left-open"/></Button>
          <Button variant="icon" className="prototype-icon-button" title={t('prototype.properties')} aria-label={t('prototype.properties')} aria-pressed={showProps} onClick={()=>changeLayout('showProps',!showProps)}><Icon name="sliders-horizontal"/></Button>
          <Button variant="icon" className="prototype-icon-button" title={t('prototype.maximize')} aria-label={t('prototype.maximize')} onClick={()=>changeLayout('maximized',!maximized)}><Icon name={maximized?'minimize-2':'maximize-2'}/></Button>
          <Button variant="icon" className="prototype-icon-button prototype-close" title={t('common.close')} aria-label={t('common.close')} onClick={close}><Icon name="x" size={19}/></Button>
        </div>
      </header>
      {error&&<div role="alert" className="prototype-error">{error}</div>}
      {work?.pending&&work.status!=='running'&&<div className="prototype-recovery"><span>{work.error||t('prototype.recovery')}</span><Button disabled={busy} onClick={()=>void action('publish')}>{t('prototype.publish')}</Button><Button disabled={busy} onClick={()=>setConfirm('discard')}>{t('prototype.discard')}</Button></div>}
      {history&&work&&<PrototypeHistory projectId={projectId} work={work} onClean={()=>void action('clean_history')}/>}
      <nav className="prototype-mobile-tabs">{['chat','preview','properties'].map(tab=><Button key={tab} onClick={()=>changeLayout('mobileTab',tab)}>{t(`prototype.${tab}` as 'prototype.chat')}</Button>)}</nav>
      <div className="prototype-columns" data-mobile-tab={mobileTab} style={{'--prototype-chat-width':`${left}px`,'--prototype-properties-width':`${right}px`} as CSSProperties}>
        {showChat&&<section className="prototype-chat">{work&&path&&<PrototypeChat key={`${work.id}:${path}`} projectId={projectId} workspaceId={work.id} path={path} selection={selection} comment={outgoing} onCommentFailed={()=>setOutgoing(null)} onCommentSent={()=>{setOutgoing(null);setComment('');setCommentTarget(null)}} disabled={locked}/>}</section>}
        {showChat&&<div role="separator" aria-label={t('prototype.resizeChat')} aria-orientation="vertical" className="prototype-divider" onPointerDown={e=>resize('left',e)}/>}
        <section className="prototype-preview">
          <div className="prototype-toolbar">
            <div role="group" aria-label={t('prototype.modeHint')} className="prototype-segmented prototype-mode-switch">
              <Button aria-pressed={!mode} onClick={()=>setMode(false)}><Icon name="panel-top" size={15}/>{t('prototype.browse')}</Button>
              <Button aria-pressed={mode} onClick={()=>setMode(true)}><Icon name="mouse-pointer" size={15}/>{t('prototype.select')}</Button>
            </div>
            <span className="prototype-toolbar-rule"/>
            <div role="group" aria-label={t('prototype.viewport')} className="prototype-segmented prototype-viewport-switch">
              <Button title={t('prototype.desktop')} aria-label={t('prototype.desktop')} aria-pressed={viewport==='desktop'} onClick={()=>changeLayout('viewport','desktop')}><Icon name="monitor" size={18}/></Button>
              <Button title={t('prototype.mobile')} aria-label={t('prototype.mobile')} aria-pressed={viewport==='mobile'} onClick={()=>changeLayout('viewport','mobile')}><Icon name="smartphone" size={18}/></Button>
            </div>
            <div className="prototype-toolbar-end">
              <select aria-label={t('prototype.zoom')} className="prototype-zoom" value={zoom} onChange={event=>changeLayout('zoom',Number(event.target.value))}>{[50,75,100,125,150].map(value=><option key={value} value={value}>{value}%</option>)}</select>
              <Button variant="icon" className="prototype-icon-button prototype-refresh" title={t('prototype.refresh')} aria-label={t('prototype.refresh')} onClick={()=>void reload()}><Icon name="refresh" size={17}/></Button>
            </div>
          </div>
          {tree&&work&&<PrototypeFiles work={work} path={path} disabled={Boolean(comment.trim())} onSelect={file=>{setPath(file);setOutgoing(null)}} onClose={()=>changeLayout('tree',false)}/>}
          <div className="prototype-frame-wrap" style={{'--prototype-preview-scale':previewScale} as CSSProperties}><div className={`prototype-canvas${viewport==='mobile'?' prototype-canvas--mobile':''}`}>{document&&<iframe ref={frame} title={path} src={fsApi.htmlPreviewUrl(document.html_preview,projectId)} sandbox={HTML_PREVIEW_SANDBOX} referrerPolicy="no-referrer" onLoad={sendMode}/>}</div>
            {mode&&target&&<div className="prototype-comment" style={{top:Math.max(8,Math.min(commentTop+8,(wrapBounds?.height||600)-150)),left:Math.max(8,Math.min(commentLeft,(wrapBounds?.width||600)-280))}} onPointerEnter={()=>{if(!commentTarget)setCommentTarget(target)}}>
              <span>{target.tag} {target.text.slice(0,24)}</span><textarea aria-label={t('prototype.comment')} placeholder={t('prototype.comment')} value={comment} onFocus={()=>setCommentTarget(target)} onChange={e=>{setCommentTarget(target);setSelection(target);setComment(e.target.value)}}/>
              <Button disabled={!comment.trim()||locked||Boolean(outgoing)} onClick={()=>{setSelection(target);setOutgoing({text:comment,key:randomUuid()});changeLayout('showChat',true)}}>{t('prototype.sendComment')}</Button><Button variant="ghost" onClick={()=>{setComment('');setCommentTarget(null);setHover(null)}}>{t('common.close')}</Button>
            </div>}
          </div>
        </section>
        {showProps&&<div role="separator" aria-label={t('prototype.resizeProperties')} aria-orientation="vertical" className="prototype-divider" onPointerDown={e=>resize('right',e)}/>}
        {showProps&&<PrototypeInspector selection={selection} document={document} disabled={locked} onEdit={edit}
          onParent={()=>frame.current?.contentWindow?.postMessage({source:'workstep-prototype-host',type:'parent'},'*')}/>}
      </div>
    </ResizablePanel>
    <ConfirmDialog open={confirm!==null} title={t(confirm==='delete'?'prototype.delete':confirm==='discard'?'prototype.discard':'prototype.closeDraft')} danger={confirm==='delete'} onCancel={()=>setConfirm(null)} onConfirm={()=>{const choice=confirm;setConfirm(null);if(choice==='close')onClose();else if(choice==='discard')void action('discard');else if(selection?.node_id)void edit(selection.node_id,'delete',{},selection.version)}}/>
  </div>,window.document.body)
}
