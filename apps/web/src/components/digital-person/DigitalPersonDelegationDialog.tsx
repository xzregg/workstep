import {lazy, Suspense, useLayoutEffect, useRef, useState, type RefObject} from 'react'
import {createPortal} from 'react-dom'
import type {DigitalActivity} from '../../api/digitalPerson'
import {useProjectStore} from '../../stores/projectStore'
import {useCompactLayout} from '../../hooks/useCompactLayout'
import {useOverlay} from '../../hooks/useOverlay'
import type {InitialSessionHistory} from '../../hooks/useChatSessionHistory'
import {useI18n} from '../../i18n'
import DigitalPersonConversationFrame from './DigitalPersonConversationFrame'
import Spinner from '../Spinner'
import './DigitalPersonDelegationDialog.css'

const ChatPage = lazy(()=>import('../../pages/ChatPage'))

/** The execution uses the existing session UI without navigating away from the digital person. */
export default function DigitalPersonDelegationDialog({delegation,onClose,onResultVisible,inline=false}:{
 inline?:boolean;delegation:DigitalActivity['delegations'][number];onClose:()=>void;onResultVisible?:(status:string)=>void
}){
 return <DigitalPersonConversationDialog projectId={delegation.project_id} initialSessionId={delegation.session_id}
  inline={inline} title={delegation.title || delegation.instruction} messageId={delegation.message_id} onClose={onClose} onResultVisible={onResultVisible}/>
}

export function DigitalPersonConversationDialog({projectId,initialSessionId,initialHistory,title,messageId,onClose,onResultVisible,floating,inline=false}:{
 projectId:string;initialSessionId:string;title:string;messageId?:string|null;onClose:()=>void;onResultVisible?:(status:string)=>void
 inline?:boolean
 initialHistory?:InitialSessionHistory
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
 const layer=<div className={inline?'digital-person-inline-conversation':'digital-person-delegation-backdrop'+(floating?' digital-person-conversation-layer':'')} onClick={floating||inline?undefined:onClose}>
  <DigitalPersonConversationFrame ref={panel} className={inline?'digital-home-chat':'digital-person-delegation-dialog'} role="dialog" aria-modal={floating?undefined:true}
   title={title} projectName={project?.name} onClose={onClose} closeRef={closeButton}
   aria-label={title} aria-hidden={closing||undefined} inert={closing||undefined} tabIndex={-1} onClick={event=>event.stopPropagation()}>
    {project?<Suspense fallback={<div className="digital-person-delegation-loading" role="status"><Spinner/>{t('common.loading')}</div>}><ChatPage embedded={{project,sessionId,quickButtons:true,initialHistory,onSessionChange:setSessionId,hideHeader:true,readTarget:{messageId:sessionId===initialSessionId?messageId??null:null,onResultVisible}}}/></Suspense>:<p role="alert">{t('digitalPerson.projectUnavailable')}</p>}
  </DigitalPersonConversationFrame>
 </div>
 return floating||inline?layer:createPortal(layer,document.body)
}
