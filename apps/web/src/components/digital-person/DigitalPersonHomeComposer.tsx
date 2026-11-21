import {useLayoutEffect,useRef,useState,type ReactNode,type RefObject} from 'react'
import {createPortal} from 'react-dom'
import {useCompactLayout} from '../../hooks/useCompactLayout'
import {useOverlay} from '../../hooks/useOverlay'
import Button from '../Button'
import Icon from '../Icon'
import ResizablePanel from '../ResizablePanel'
import {useI18n} from '../../i18n'
import type {AssistantChatMessage} from '../../stores/assistantStore'
import ChatInput from '../ChatInput'
import './DigitalPersonHomeComposer.css'

interface Props{
 projectId:string;sessionId:string;shown:boolean;onClose:()=>void;active:boolean;running:boolean;voiceDisabled?:boolean
 messages:AssistantChatMessage[]
 value:string;onChange:(value:string)=>void;anchorRef?:RefObject<HTMLButtonElement|null>;inputRef?:RefObject<HTMLTextAreaElement|null>
 onSend:(content?:string,facePersonIds?:string[],recentFaces?:boolean)=>Promise<boolean>
 onSendPending:(content:string,ids:string[])=>Promise<boolean>;onStop:()=>void
 /** Queue owned by the avatar home so voice turns share the typed-message path. */
 pendingPanel?:ReactNode;pendingError?:string;queueEnabled:boolean;queueCurrentInput:(content?:string)=>Promise<boolean>
}
export default function DigitalPersonHomeComposer(props:Props){
 const {t}=useI18n(),compact=useCompactLayout()
 const dialog=useRef<HTMLDivElement>(null),backdrop=useRef<HTMLDivElement>(null),fallbackInput=useRef<HTMLTextAreaElement>(null)
 const inputRef=props.inputRef??fallbackInput
 const {anchorRef,shown}=props
 useLayoutEffect(()=>{
  const anchor=anchorRef?.current,layer=backdrop.current
  if(!shown||!anchor||!layer)return
  const viewport=window.visualViewport
  const update=()=>{
   const box=anchor.getBoundingClientRect()
   layer.style.setProperty('--composer-anchor-x',`${box.left+box.width/2}px`)
   layer.style.setProperty('--composer-anchor-y',`${box.top}px`)
   layer.style.setProperty('--composer-viewport-top',`${viewport?.offsetTop??0}px`)
  }
  update()
  const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(update)
  observer?.observe(anchor.closest('footer')??anchor)
  window.addEventListener('resize',update)
  viewport?.addEventListener('resize',update)
  viewport?.addEventListener('scroll',update)
  return()=>{
   observer?.disconnect()
   window.removeEventListener('resize',update)
   viewport?.removeEventListener('resize',update)
   viewport?.removeEventListener('scroll',update)
  }
 },[anchorRef,shown])
 useOverlay(props.shown,props.onClose,dialog,compact,true,inputRef)
 const {pendingPanel:panel,pendingError:queueError,queueEnabled,queueCurrentInput}=props
 const [error,setError]=useState(false)
 const inFlight=useRef(false)
 const send=async(content?:string,ids?:string[],recentFaces?:boolean)=>{
  if(!props.active||!(content??props.value).trim()||(props.running&&!queueEnabled))return false
  setError(false)
  if(props.running&&queueEnabled&&!ids?.length)return queueCurrentInput(content)
  if(inFlight.current)return false
  inFlight.current=true
  try{const accepted=await props.onSend(content,ids,recentFaces);if(!accepted)setError(true);return accepted}catch{setError(true);return false}finally{inFlight.current=false}
 }
 if(!props.shown&&!panel&&!error&&!queueError)return null
 const content=<div className="digital-home-composer">
  {panel}
  {(error||queueError)&&<p className="digital-home-composer-error" role="alert">{queueError||t('chatSession.sendFailed')}</p>}
  {props.shown&&<ChatInput inputRef={inputRef} value={props.value} onChange={props.onChange} onSend={(content,ids,recent)=>{void send(content,ids,recent)}}
   projectId={props.projectId} sessionId={props.sessionId} imageAttach={{projectId:props.projectId}} running={props.running} allowSendWhileRunning={queueEnabled} onStop={props.onStop} disabled={!props.active||(props.running&&!queueEnabled)} externalVoiceActive={props.voiceDisabled}/>}
 </div>
 if(!props.shown)return content
 return createPortal(<div ref={backdrop} className="digital-home-composer-backdrop" onClick={props.onClose}>
  <div className="digital-home-composer-anchor">
   <ResizablePanel ref={dialog} minWidth={360} minHeight={200} className="digital-home-composer-dialog" role="dialog" aria-modal="true" aria-label={t('digitalPerson.homeKeyboard')} tabIndex={-1} onClick={event=>event.stopPropagation()}>
    <header>
     <h2>{t('digitalPerson.homeKeyboard')}</h2>
     <Button variant="icon" aria-label={t('common.close')} onClick={props.onClose}><Icon name="x"/></Button>
    </header>
    {content}
   </ResizablePanel>
  </div>
 </div>,document.body)
}
