import { useEffect, useRef, useState } from 'react'
import type { DigitalPersonProfile } from '../../api/digitalPerson'
import DigitalPersonAvatar from './DigitalPersonAvatar'
import Button from '../Button'
import Icon from '../Icon'
import { useI18n } from '../../i18n'
import './DigitalPersonCompanion.css'

export default function DigitalPersonCompanion({ profile, replyId, reply, running, inline = false, title, hideIdentity = false }: {hideIdentity?:boolean;inline?:boolean;title?:string;profile:DigitalPersonProfile;replyId?:string;reply?:string;running?:boolean}) {
  const {t} = useI18n()
  const [speaking,setSpeaking] = useState(false), [error,setError] = useState('')
  const supported = typeof window.speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined'
  const seen = useRef(replyId), observedRunning = useRef(false), utterance = useRef<SpeechSynthesisUtterance|null>(null)
  const stop = () => { if(utterance.current){utterance.current.onend=null;utterance.current.onerror=null;window.speechSynthesis?.cancel();utterance.current=null}setSpeaking(false) }
  const play = (text:string) => {
    stop();setError('')
    if(!window.speechSynthesis || typeof SpeechSynthesisUtterance==='undefined'){setError(t('digitalPerson.voiceUnavailable'));return}
    const speech = new SpeechSynthesisUtterance(text)
    speech.lang='zh-CN';speech.rate=profile.voice_rate ?? 1
    speech.voice=window.speechSynthesis.getVoices().find(v=>v.name===profile.voice_name) ?? null
    speech.onstart=()=>setSpeaking(true);speech.onend=()=>{setSpeaking(false);utterance.current=null}
    speech.onerror=()=>{setSpeaking(false);setError(t('digitalPerson.voiceFailed'));utterance.current=null}
    utterance.current=speech;window.speechSynthesis.speak(speech)
  }
  useEffect(()=>{
    if(running){observedRunning.current=true;return}
    if(!replyId || seen.current===replyId)return
    if(!seen.current && !observedRunning.current){seen.current=replyId;return}
    seen.current=replyId
    if(profile.auto_speak && reply && supported)play(reply)
    // Only completed new replies trigger playback; settings changes never replay history.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[replyId,reply,running])
  useEffect(()=>{
    window.dispatchEvent(new window.CustomEvent('workstep:digital-person-speaking',{detail:speaking}))
    return ()=>{window.dispatchEvent(new window.CustomEvent('workstep:digital-person-speaking',{detail:false}))}
  },[speaking])
  useEffect(()=>()=>{if(utterance.current){utterance.current.onstart=null;utterance.current.onend=null;utterance.current.onerror=null;window.speechSynthesis?.cancel()}},[])
  if(hideIdentity)return null
  if(profile.show_panel===false && (!profile.floating || window.workstepDesktop?.digitalPerson))return null
  return <aside className={`digital-person-companion ${profile.floating && !window.workstepDesktop?.digitalPerson?'digital-person-companion--floating':''} ${inline?'digital-person-companion--inline':''}`} aria-label={profile.name}>
    <DigitalPersonAvatar avatar={profile.avatar} speaking={speaking} expression={profile.expression}/>
    <div className="digital-person-companion-identity"><strong>{title || profile.name}</strong><small>{running?t('chatSession.thinking'):profile.role}</small></div>
    {supported && reply && <Button variant="ghost" className="digital-person-companion-play" aria-label={t(speaking?'digitalPerson.stopVoice':'digitalPerson.playReply')} title={error ? t('digitalPerson.voiceFailed') : t(speaking?'digitalPerson.stopVoice':'digitalPerson.playReply')} onClick={()=>speaking?stop():play(reply)}><Icon name={speaking?'square':'volume'} size={16}/></Button>}
    {error && <span role="status" className="digital-person-companion-error">{t('digitalPerson.playbackFailed')}</span>}
  </aside>
}
