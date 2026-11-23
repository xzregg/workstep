import {useEffect,useLayoutEffect,useRef,type PointerEvent} from 'react'
import {useI18n} from '../../i18n'
import Button from '../Button'
import Icon from '../Icon'
import Spinner from '../Spinner'
import type {VoicePhase} from '../../hooks/useVoiceInput'
import SkinnedComposerSendIcon from '../ComposerSendIcon'
import {DigitalPersonCameraToggle} from './DigitalPersonCamera'
import {createCanvasLoop} from './avatar/canvasLoop'
import {advanceMicLevel} from './avatar/visualState'
import {useDelayedPending} from './useDelayedPending'

interface Props {
 canCompose:boolean; speakerMuted:boolean; onToggleSound:()=>void
 microphoneOn:boolean; microphoneAction:string; microphoneDisabled:boolean; microphonePending?:Extract<VoicePhase,'requesting'|'preparing'|'finishing'>
 readSpeechLevel?:()=>number; onMicrophone:()=>void; onHoldMicrophone:()=>void
 action:'stop'|'send'|'hangup'|'phone'; actionDisabled:boolean; sending:boolean; stopping?:boolean; onAction:()=>void
}

export default function DigitalPersonVoiceDock(props:Props){
 const {t}=useI18n()
 const microphoneBusy=Boolean(props.microphonePending)
 const microphoneStarting=props.microphonePending==='requesting'
 const actionBusy=props.action==='send'&&props.sending||props.action==='stop'&&Boolean(props.stopping)
 const showMicPending=useDelayedPending(microphoneBusy)
 const showActionPending=useDelayedPending(actionBusy)
 const micPendingLabel=props.microphonePending?t(`speech.${props.microphonePending}`):undefined
 const soundAction=t(props.speakerMuted?'digitalPerson.homeEnableSound':'digitalPerson.homeMuteSound')
 const micFill=useRef<HTMLSpanElement>(null)
 const readSpeechLevel=props.microphoneOn&&!props.microphoneDisabled?props.readSpeechLevel:undefined
 useEffect(()=>{
  const element=micFill.current
  if(!element||!readSpeechLevel||typeof ResizeObserver!=='function'||typeof IntersectionObserver!=='function')return
  let level=0
  const loop=createCanvasLoop(element,(_now,delta,reduced)=>{
   const next=reduced?0:advanceMicLevel(level,readSpeechLevel(),delta)
   if(next!==level){
    level=next
    element.style.setProperty('--mic-level',String(level))
   }
   return !reduced
  })
  return ()=>{
   loop.dispose()
   element.style.removeProperty('--mic-level')
  }
 },[readSpeechLevel])
 const timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined)
 const origin=useRef<{id:number;x:number;y:number}|null>(null)
 const suppressClick=useRef(false)
 const hold=useRef(props.onHoldMicrophone)
 useLayoutEffect(()=>{hold.current=props.onHoldMicrophone},[props.onHoldMicrophone])
 const clearPress=()=>{clearTimeout(timer.current);origin.current=null}
 useEffect(()=>clearPress,[props.microphoneDisabled,microphoneStarting])
 const startPress=(event:PointerEvent<HTMLButtonElement>)=>{
  if(microphoneStarting||event.button!==0||origin.current)return
  suppressClick.current=false
  origin.current={id:event.pointerId,x:event.clientX,y:event.clientY}
  event.currentTarget.setPointerCapture?.(event.pointerId)
  timer.current=setTimeout(()=>{suppressClick.current=true;if(!document.hidden)hold.current()},550)
 }
 const finishPress=(event:PointerEvent<HTMLButtonElement>)=>{if(origin.current?.id===event.pointerId)clearPress()}
 const movePress=(event:PointerEvent<HTMLButtonElement>)=>{
  const start=origin.current
  if(start?.id===event.pointerId&&Math.hypot(event.clientX-start.x,event.clientY-start.y)>10){
   suppressClick.current=true;clearPress()
  }
 }
 const labels={stop:'common.stop',send:'chatInput.send',hangup:'digitalPerson.homeEndContinuousVoice',phone:'digitalPerson.homeStartContinuousVoice'} as const
 const glyphs={stop:'square',hangup:'phone-off',phone:'phone'} as const
 const actionLabel=t(labels[props.action])
 return <><div className="digital-home-voice-dock">
  <DigitalPersonCameraToggle/>
  <Button variant="ghost" className="digital-home-speaker" onClick={props.onToggleSound} aria-label={t('digitalPerson.homeSound')}
   aria-description={soundAction} title={soundAction} aria-pressed={!props.speakerMuted}><Icon name={props.speakerMuted?'volume-off':'volume'} size={24}/></Button>
  <Button variant="ghost" className="digital-home-microphone" aria-label={t('digitalPerson.homeMicrophone')}
   aria-description={microphoneStarting?micPendingLabel:props.microphoneAction}
   title={microphoneStarting?micPendingLabel:`${props.microphoneAction} · ${t('digitalPerson.homeHoldToCall')}`}
   aria-pressed={props.microphoneOn} aria-keyshortcuts="Shift+Enter" aria-busy={microphoneBusy} aria-disabled={microphoneStarting||undefined} disabled={props.microphoneDisabled}
   onPointerDown={startPress} onPointerMove={movePress} onPointerUp={finishPress} onPointerCancel={finishPress} onLostPointerCapture={finishPress}
   onContextMenu={event=>event.preventDefault()}
   onKeyDown={event=>{if(event.shiftKey&&event.key==='Enter'){event.preventDefault();if(!microphoneStarting&&!event.repeat)hold.current()}}}
   onClick={event=>{if(event.detail&&suppressClick.current){suppressClick.current=false;return}if(!microphoneStarting)props.onMicrophone()}}>
   {props.microphoneOn
    ?<Icon name="mic" className="digital-home-mic-on" size={24}/>
    :!showMicPending&&<Icon name="mic-off" className="digital-home-mic-off" size={24}/>}
   {showMicPending&&(props.microphoneOn?<Spinner className="digital-home-mic-pending" size={32}/>:<Spinner size={16}/>)}
   {readSpeechLevel&&<span ref={micFill} className="digital-home-mic-fill" aria-hidden="true">
    <Icon name="mic" fill size={24}/>
   </span>}
  </Button>
  <Button variant={props.action==='send'?'primary':'ghost'} className="digital-home-end" data-action={props.action}
   aria-label={actionLabel} title={actionLabel} aria-busy={actionBusy} aria-disabled={actionBusy||undefined}
   disabled={!props.canCompose||props.actionDisabled} onClick={()=>{if(!actionBusy)props.onAction()}}>
   {showActionPending?<Spinner size={16}/>:props.action==='send'?<SkinnedComposerSendIcon size={24} strokeWidth={2}/>:<Icon name={glyphs[props.action]} size={24}/>}
  </Button>
 </div><span className="digital-home-control-status" role="status">
  {showMicPending?micPendingLabel:showActionPending?t(props.action==='stop'?'chatInput.stopping':'digitalPerson.homeSendingVoice'):''}
 </span></>
}
