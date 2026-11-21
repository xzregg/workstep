import {lazy, Suspense, useLayoutEffect, useRef, useState, type RefObject} from 'react'
import {createPortal} from 'react-dom'
import type {DigitalActivity} from '../../api/digitalPerson'
import {useProjectStore} from '../../stores/projectStore'
import {useCompactLayout} from '../../hooks/useCompactLayout'
import {useOverlay} from '../../hooks/useOverlay'
import {useI18n} from '../../i18n'
import ResizablePanel from '../ResizablePanel'
import Button from '../Button'
import Icon from '../Icon'
import Spinner from '../Spinner'
import './DigitalPersonDelegationDialog.css'

const ChatPage = lazy(()=>import('../../pages/ChatPage'))

/** The execution uses the existing session UI without navigating away from the digital person. */
export default function DigitalPersonDelegationDialog({delegation,onClose,onResultVisible}:{
 delegation:DigitalActivity['delegations'][number];onClose:()=>void;onResultVisible?:(status:string)=>void
}){
 return <DigitalPersonConversationDialog projectId={delegation.project_id} initialSessionId={delegation.session_id}
  title={delegation.instruction} messageId={delegation.message_id} onClose={onClose} onResultVisible={onResultVisible}/>
}

export function DigitalPersonConversationDialog({projectId,initialSessionId,title,messageId,onClose,onResultVisible,floating}:{
 projectId:string;initialSessionId:string;title:string;messageId?:string|null;onClose:()=>void;onResultVisible?:(status:string)=>void
 floating?:{anchor:RefObject<HTMLElement|null>;closing:boolean;onExited:()=>void}
}){
 const {t}=useI18n(),panel=useRef<HTMLDivElement>(null),compact=useCompactLayout()
 const closeButton=useRef<HTMLButtonElement>(null)
 const project=useProjectStore(s=>s.projects.find(item=>item.id===projectId))
 const [sessionId,setSessionId]=useState<string|null>(initialSessionId)
 const {anchor,closing,onExited}=floating??{}
 const close=useRef(onClose),exited=useRef(onExited)
 useLayoutEffect(()=>{close.current=onClose;exited.current=onExited},[onClose,onExited])
 useOverlay(!floating,onClose,panel,compact)
 useLayoutEffect(()=>{
  if(!anchor)return
  const previous=document.activeElement,element=panel.current
  closeButton.current?.focus({preventScroll:true})
  const keydown=(event:KeyboardEvent)=>{
   if(event.key==='Escape'&&!event.defaultPrevented){event.stopPropagation();close.current()}
  }
  document.addEventListener('keydown',keydown)
  return()=>{
   document.removeEventListener('keydown',keydown)
   if(previous instanceof HTMLElement&&previous.isConnected&&
    (document.activeElement===document.body||element?.contains(document.activeElement)))previous.focus()
  }
 },[anchor])
 useLayoutEffect(()=>{
  const element=panel.current,source=anchor?.current
  if(!element||!anchor)return
  if(!element.animate||window.matchMedia?.('(prefers-reduced-motion: reduce)').matches){
   if(closing)exited.current?.()
   return
  }
  const box=element.getBoundingClientRect(),origin=source?.getBoundingClientRect()
  const x=origin?.width ? origin.left+origin.width/2-box.left-box.width/2 : 0
  const y=origin?.height ? origin.top+origin.height/2-box.top-box.height/2 : 0
  const small={transform:'translate('+x+'px, '+y+'px) scale(.18)',opacity:.15}
  const large={transform:'none',opacity:1}
  const style=getComputedStyle(element)
  const duration=parseFloat(style.getPropertyValue('--motion-fast'))||150
  const easing=style.getPropertyValue('--ease').trim()||'ease-out'
  const animation=element.animate(closing?[large,small]:[small,large],{duration,easing,fill:'both'})
  void animation.finished.then(()=>{if(closing)exited.current?.();else animation.cancel()},()=>{})
  return()=>animation.cancel()
 },[anchor,closing])
 const layer=<div className={'digital-person-delegation-backdrop'+(floating?' digital-person-conversation-layer':'')} onClick={floating?undefined:onClose}>
  <ResizablePanel ref={panel} className="digital-person-delegation-dialog" minWidth={480} minHeight={360} role="dialog" aria-modal={floating?undefined:true}
   aria-label={title} aria-hidden={closing||undefined} inert={closing||undefined} tabIndex={-1} onClick={event=>event.stopPropagation()}>
   <header>
    <h2 title={title}>{title}</h2>
    {project&&<p className="digital-person-delegation-project" title={project.name}><Icon name="folder" size={14}/><span>{project.name}</span></p>}
    <Button ref={closeButton} variant="icon" className="digital-person-delegation-close" aria-label={t('common.close')} onClick={onClose}><Icon name="x"/></Button>
   </header>
   <div className="digital-person-delegation-content">
    {project?<Suspense fallback={<div className="digital-person-delegation-loading" role="status"><Spinner/>{t('common.loading')}</div>}><ChatPage embedded={{project,sessionId,onSessionChange:setSessionId,hideHeader:true,readTarget:{messageId:sessionId===initialSessionId?messageId??null:null,onResultVisible}}}/></Suspense>:<p role="alert">{t('digitalPerson.projectUnavailable')}</p>}
   </div>
  </ResizablePanel>
 </div>
 return floating?layer:createPortal(layer,document.body)
}
