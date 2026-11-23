import {OUTPUT_CHANGED} from '../../api/speechOutput'
import { useEffect } from 'react'
import { SpeechOutputPlayer, speechText } from '../../utils/speechOutput'
import { loadSpeechOutputSettings } from '../../utils/speechOutputSettings'
import { DIGITAL_OUTPUT_FRAME, STOP_DIGITAL_SPEECH } from './digitalPersonVoiceEvents'
import { PROACTIVE_MESSAGE, PROACTIVE_SPEECH_CHANGED, STOP_FACE_WELCOME, getProactiveSpeechContext, type ProactiveMessage } from './digitalPersonProactive'

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
   const local=getProactiveSpeechContext()
   if(local?.projectId!==value.projectId||local.sessionId!==value.sessionId||local.muted||local.blockNew)return
   const profile=local.profile
   if(!profile.enabled||!profile.auto_speak)return
   stop();current=value;const request=sequence
   try{
    const settings=await loadSpeechOutputSettings(value.projectId)
    if(!alive||request!==sequence||document.hidden)return
    const latest=getProactiveSpeechContext()
    if(!latest||latest.projectId!==value.projectId||latest.sessionId!==value.sessionId||latest.muted||latest.blockNew||!latest.profile.enabled||!latest.profile.auto_speak)return
    const frame={projectId:value.projectId,sessionId:value.sessionId,source:value.welcome?'welcome':'proactive',metered:settings.mode!=='system'&&settings.volume>0,playing:false,busy:false,level:0}
    const publish=()=>window.dispatchEvent(new window.CustomEvent(DIGITAL_OUTPUT_FRAME,{detail:{...frame}}))
    player=new SpeechOutputPlayer({projectId:value.projectId,digitalSessionId:value.sessionId,settings:{...settings,rate:profile.voice_rate??settings.rate},systemVoice:profile.voice_name,
     onPlayback:playing=>{frame.playing=playing;publish()},
     onLevel:level=>{frame.level=level;publish()},
     onState:busy=>{frame.busy=busy;publish()},
     onError:()=>{stop()}})
    const text=value.privateSpeechFallback&&settings.mode!=='local'?value.privateSpeechFallback:value.text
    player.enqueue([value.welcome?text:speechText(text)])
   }catch{stop()}
  }
  const preference=()=>{const local=getProactiveSpeechContext();if(!local||local.muted||(local.blockNew&&!player)||!local.profile.enabled||!local.profile.auto_speak||current?.projectId!==local.projectId||current.sessionId!==local.sessionId)stop()}
  const interrupt=(event:Event)=>{const detail=(event as CustomEvent).detail;if(current?.projectId===detail?.projectId&&current?.sessionId===detail?.sessionId)stop()}
  const stopWelcome=(event:Event)=>{if(current?.welcome&&current.messageId===(event as CustomEvent<string>).detail)stop()}
  const visibility=()=>{if(document.hidden)stop()}
  window.addEventListener(PROACTIVE_MESSAGE,receive)
  window.addEventListener(PROACTIVE_SPEECH_CHANGED,preference)
  window.addEventListener(STOP_DIGITAL_SPEECH,interrupt)
  window.addEventListener(STOP_FACE_WELCOME,stopWelcome)
  document.addEventListener('visibilitychange',visibility)
  window.addEventListener(OUTPUT_CHANGED,stop)
  return()=>{alive=false;stop();window.removeEventListener(PROACTIVE_MESSAGE,receive);window.removeEventListener(PROACTIVE_SPEECH_CHANGED,preference);window.removeEventListener(STOP_DIGITAL_SPEECH,interrupt);window.removeEventListener(STOP_FACE_WELCOME,stopWelcome);document.removeEventListener('visibilitychange',visibility);window.removeEventListener(OUTPUT_CHANGED,stop)}
 },[])
 return null
}
