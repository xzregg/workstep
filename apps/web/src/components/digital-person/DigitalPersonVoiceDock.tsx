import {useEffect,useRef,type PointerEvent} from 'react'
import {useI18n} from '../../i18n'
import Button from '../Button'
import Icon from '../Icon'
import SkinnedComposerSendIcon from '../ComposerSendIcon'
import {DigitalPersonCameraToggle} from './DigitalPersonCamera'

interface Props {
 canCompose:boolean; speakerMuted:boolean; onToggleSound:()=>void
 microphoneOn:boolean; microphoneLabel:string; microphoneDisabled:boolean; microphoneBusy:boolean
 onMicrophone:()=>void; onHoldMicrophone:()=>void
 action:'stop'|'send'|'hangup'|'phone'; actionDisabled:boolean; sending:boolean; onAction:()=>void
}

export default function DigitalPersonVoiceDock(props:Props){
 const {t}=useI18n()
 const timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined)
 const origin=useRef<{id:number;x:number;y:number}|null>(null)
 const suppressClick=useRef(false)
 const hold=useRef(props.onHoldMicrophone);hold.current=props.onHoldMicrophone
 const clearPress=()=>{clearTimeout(timer.current);origin.current=null}
 useEffect(()=>clearPress,[props.microphoneDisabled])
 const startPress=(event:PointerEvent<HTMLButtonElement>)=>{
  if(event.button!==0||origin.current)return
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
 return <div className="digital-home-voice-dock">
  <DigitalPersonCameraToggle/>
  <Button variant="ghost" className="digital-home-speaker" onClick={props.onToggleSound} aria-label={t(props.speakerMuted?'digitalPerson.homeEnableSound':'digitalPerson.homeMuteSound')} aria-pressed={!props.speakerMuted}><Icon name={props.speakerMuted?'volume-off':'volume'} size={24}/></Button>
  <Button variant="ghost" className="digital-home-microphone" aria-label={props.microphoneLabel} title={`${props.microphoneLabel} · ${t('digitalPerson.homeHoldToCall')}`}
   aria-pressed={props.microphoneOn} aria-keyshortcuts="Shift+Enter" loading={props.microphoneBusy} disabled={props.microphoneDisabled}
   onPointerDown={startPress} onPointerMove={movePress} onPointerUp={finishPress} onPointerCancel={finishPress} onLostPointerCapture={finishPress}
   onContextMenu={event=>event.preventDefault()}
   onKeyDown={event=>{if(event.shiftKey&&event.key==='Enter'){event.preventDefault();if(!event.repeat)hold.current()}}}
   onClick={event=>{if(event.detail&&suppressClick.current){suppressClick.current=false;return}props.onMicrophone()}}>
   <Icon name={props.microphoneOn?'mic':'mic-off'} size={24}/>
  </Button>
  <Button variant={props.action==='send'?'primary':'ghost'} className="digital-home-end" data-action={props.action}
   aria-label={actionLabel} title={actionLabel} aria-pressed={props.action==='phone'?false:props.action==='hangup'?true:undefined}
   disabled={!props.canCompose||props.actionDisabled} loading={props.sending} onClick={props.onAction}>
   {props.action==='send'?<SkinnedComposerSendIcon size={24} strokeWidth={2}/>:<Icon name={glyphs[props.action]} size={24}/>}
  </Button>
 </div>
}
