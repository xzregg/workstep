import {OUTPUT_CHANGED} from '../../api/speechOutput'
import { useEffect } from 'react'
import { SpeechOutputPlayer, speechText } from '../../utils/speechOutput'
import { loadSpeechOutputSettings } from '../../utils/speechOutputSettings'
import { DIGITAL_OUTPUT_FRAME, STOP_DIGITAL_SPEECH } from './digitalPersonVoiceEvents'
import { PROACTIVE_MESSAGE, PROACTIVE_SPEECH_CHANGED, getProactiveSpeechContext, type ProactiveMessage } from './digitalPersonProactive'

/** Live host events only. Never reads message history or creates a session. */
export default function DigitalPersonProactiveSpeech(){
 useEffect(()=>{
  let alive=true,sequence=0,player:SpeechOutputPlayer|null=null,current:ProactiveMessage|null=null
  const seen=new Set<string>()
  const stop=()=>{sequence++;player?.stop();player=null}
  const receive=async(event:Event)=>{
   const value=(event as CustomEvent<ProactiveMessage>).detail
   const key=value.projectId+':'+value.messageId
   if(seen.has(key))return
   seen.add(key);if(seen.size>200)seen.delete(seen.values().next().value!)
   // Consume while hidden too: returning to the page must never replay it.
   if(document.hidden)return
   stop();current=value;const request=sequence
   try{
    const local=getProactiveSpeechContext()
    const matches=local?.projectId===value.projectId&&local.sessionId===value.sessionId
    if(!matches||local.muted)return
    const profile=local.profile
    if(!profile.enabled||!profile.auto_speak)return
    const settings=await loadSpeechOutputSettings(value.projectId)
    if(!alive||request!==sequence||document.hidden)return
    const latest=getProactiveSpeechContext()
    if(!latest||latest.projectId!==value.projectId||latest.sessionId!==value.sessionId||latest.muted||!latest.profile.enabled||!latest.profile.auto_speak)return
    player=new SpeechOutputPlayer({projectId:value.projectId,settings:{...settings,rate:profile.voice_rate??settings.rate},systemVoice:profile.voice_name,
     onState:busy=>window.dispatchEvent(new window.CustomEvent(DIGITAL_OUTPUT_FRAME,{detail:{projectId:value.projectId,sessionId:value.sessionId,playing:busy,busy,level:0}})),
     onError:()=>{stop()}})
    player.enqueue([speechText(value.text)])
   }catch{stop()}
  }
  const preference=()=>{const local=getProactiveSpeechContext();if(!local||local.muted||!local.profile.enabled||!local.profile.auto_speak||current?.projectId!==local.projectId||current.sessionId!==local.sessionId)stop()}
  const interrupt=(event:Event)=>{const detail=(event as CustomEvent).detail;if(current?.projectId===detail?.projectId&&current?.sessionId===detail?.sessionId)stop()}
  const visibility=()=>{if(document.hidden)stop()}
  window.addEventListener(PROACTIVE_MESSAGE,receive)
  window.addEventListener(PROACTIVE_SPEECH_CHANGED,preference)
  window.addEventListener(STOP_DIGITAL_SPEECH,interrupt)
  document.addEventListener('visibilitychange',visibility)
  window.addEventListener(OUTPUT_CHANGED,stop)
  return()=>{alive=false;stop();window.removeEventListener(PROACTIVE_MESSAGE,receive);window.removeEventListener(PROACTIVE_SPEECH_CHANGED,preference);window.removeEventListener(STOP_DIGITAL_SPEECH,interrupt);document.removeEventListener('visibilitychange',visibility);window.removeEventListener(OUTPUT_CHANGED,stop)}
 },[])
 return null
}
