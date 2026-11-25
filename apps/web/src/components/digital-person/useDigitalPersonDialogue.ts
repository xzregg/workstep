import {useCallback,useEffect,useRef,useState} from 'react'
import {primeSpeechOutput} from '../../utils/speechOutput'
import {useVoiceInput} from '../../hooks/useVoiceInput'
import {stopDigitalSpeech} from './digitalPersonVoiceEvents'
interface Options{
 projectId:string;sessionId:string;active:boolean;running:boolean;speaking:boolean;showLevel?:boolean
 onRecognized:(text:string)=>void;onSendDraft?:(text:string)=>Promise<boolean>;onStop:()=>Promise<boolean>
}
/** Owns the conversation microphone, including rearming after playback. */
export function useDigitalPersonDialogue(options:Options){
 const [connected,setConnected]=useState(false),[muted,setMuted]=useState(false),[error,setError]=useState('')
 const [continuous,setContinuous]=useState(false),continuousRef=useRef(false)
 const wakeCall=useRef(false)
 const [callMicMuted,setCallMicMuted]=useState(false)
 const [playbackOverride,setPlaybackOverride]=useState(false)
 const playbackPaused=options.speaking&&!playbackOverride
 const [draft,setDraft]=useState<string|null>(null),draftRef=useRef<string|null>(null)
 const [sending,setSending]=useState(false),sendingRef=useRef(false),retryDevice=useRef(true)
 const updateDraft=(value:string|null)=>{draftRef.current=value;setDraft(value)}
 const epoch=useRef(0)
 const latest=useRef({...options,playbackPaused});latest.current={...options,playbackPaused}
 const connectedRef=useRef(false),mutedRef=useRef(false)
 connectedRef.current=connected;mutedRef.current=muted
 const resumeAfter=useRef(0),wasSpeaking=useRef(false),listenStarted=useRef(0)
 const stopAfterFinish=useRef(false)
 const voice=useVoiceInput({ownerKey:`digital-dialogue:${options.projectId}:${options.sessionId}`,projectId:options.projectId,
  disabled:!options.active,compact:false,value:'',cursor:0,deliverSegments:true,showLevel:options.showLevel,reuseCaptureContext:true,trackSpeechLevel:true,onInsert:text=>{
   if(!connectedRef.current||mutedRef.current||!latest.current.active||latest.current.playbackPaused)return
   if(!/[\p{L}\p{N}]/u.test(text))return
   retryDevice.current=true
   const segment=text.trim()
   if(continuousRef.current)latest.current.onRecognized(segment)
   else updateDraft(draftRef.current?`${draftRef.current} ${segment}`:segment)
  }})
 const capture=useRef(voice);capture.current=voice
 const end=useCallback(()=>{
  stopAfterFinish.current=false
  stopDigitalSpeech(options.projectId,options.sessionId)
  epoch.current++;connectedRef.current=false;setConnected(false);setMuted(false);capture.current.cancel()
  sendingRef.current=false;setSending(false)
  continuousRef.current=false;setContinuous(false);wakeCall.current=false
 },[options.projectId,options.sessionId])
 useEffect(()=>{
  if(voice.phase==='recording')listenStarted.current=performance.now()
  if(voice.phase==='error'){
   stopAfterFinish.current=false
   if(voice.error==='speech.deviceLost'&&retryDevice.current&&connectedRef.current&&!mutedRef.current
      &&latest.current.active&&!latest.current.playbackPaused&&!document.hidden){
    retryDevice.current=false
    capture.current.cancel()
   }else{mutedRef.current=true;setMuted(true);setError(voice.error)}
  }
 },[voice.phase,voice.error])
 useEffect(()=>{
  if(voice.phase==='idle'&&stopAfterFinish.current){
   stopAfterFinish.current=false
   connectedRef.current=false
   setConnected(false)
   return
  }
  if(playbackPaused){
   wasSpeaking.current=true
   if(capture.current.active)capture.current.cancel()
   return
  }
  if(wasSpeaking.current){
   wasSpeaking.current=false
   resumeAfter.current=options.speaking?0:performance.now()+600
  }
  if(!connected||muted||!options.active||document.hidden||voice.phase!=='idle')return
  const start=()=>{
   const current=latest.current
   if(connectedRef.current&&!mutedRef.current&&current.active&&!current.playbackPaused&&!document.hidden){
    void capture.current.start(continuousRef.current)
   }
  }
  const delay=Math.max(0,resumeAfter.current-performance.now())
  if(!delay){start();return}
  const timer=setTimeout(start,delay)
  return()=>clearTimeout(timer)
 },[connected,muted,voice.phase,options.active,options.speaking,playbackPaused])
 useEffect(()=>{if(!options.speaking||!connected||!options.active)setPlaybackOverride(false)},[options.speaking,connected,options.active])
 useEffect(()=>{
  if(!connected||muted||!continuous)return
  const timer=setInterval(()=>{
   const now=performance.now()
   if(wakeCall.current){
    if(latest.current.running||latest.current.speaking||capture.current.phase!=='recording'||capture.current.hasSpeech){
     listenStarted.current=now
    }else if(now-listenStarted.current>=60000)end()
    return
   }
   if(latest.current.speaking||capture.current.phase!=='recording')return
   if(capture.current.hasSpeech)listenStarted.current=now
   else if(now-listenStarted.current>=15000){
    mutedRef.current=true;setMuted(true);capture.current.cancel()
   }
  },100)
  return()=>clearInterval(timer)
 },[connected,muted,continuous,end])
 useEffect(()=>{
  stopAfterFinish.current=false
  setPlaybackOverride(false)
  updateDraft(null);sendingRef.current=false;setSending(false)
  const leave=()=>{
   stopAfterFinish.current=false
   connectedRef.current=false;setConnected(false);setMuted(false);capture.current.cancel()
   continuousRef.current=false;setContinuous(false)
   stopDigitalSpeech(options.projectId,options.sessionId)
  }
  const hide=()=>{if(document.hidden)leave()}
  document.addEventListener('visibilitychange',hide)
  window.addEventListener('pagehide',leave)
  return()=>{
   epoch.current++;connectedRef.current=false;capture.current.cancel();stopDigitalSpeech(options.projectId,options.sessionId)
   document.removeEventListener('visibilitychange',hide)
   window.removeEventListener('pagehide',leave)
  }
 },[options.projectId,options.sessionId])
 useEffect(()=>{if(!options.active){connectedRef.current=false;setConnected(false);continuousRef.current=false;setContinuous(false);capture.current.cancel()}},[options.active])
 const begin=(keepListening:boolean,overridePlayback=false)=>{
  stopAfterFinish.current=false
  if(continuousRef.current!==keepListening&&voice.active)voice.cancel()
  retryDevice.current=true
  continuousRef.current=keepListening;setContinuous(keepListening)
  setCallMicMuted(false)
  setPlaybackOverride(overridePlayback)
  primeSpeechOutput()
  connectedRef.current=true;mutedRef.current=false;setConnected(true);setMuted(false);setError('')
  if(!voice.active&&(overridePlayback||(!options.speaking&&performance.now()>=resumeAfter.current)))void voice.start(keepListening)
 }
 const mute=()=>{stopAfterFinish.current=false;mutedRef.current=true;setMuted(true);setPlaybackOverride(false);voice.cancel()}
 const toggle=()=>{
  if(continuousRef.current){
   if(options.speaking&&!options.running){
    wasSpeaking.current=false
    resumeAfter.current=0
    stopDigitalSpeech(options.projectId,options.sessionId)
    begin(true,true)
   }else if(mutedRef.current||playbackPaused)begin(true,options.speaking)
   else{setCallMicMuted(true);mute()}
   return
  }
  if(connected&&!muted&&!playbackPaused){
   if(stopAfterFinish.current)return
   if(voice.phase==='recording'){
    stopAfterFinish.current=true
    void voice.finish()
    return
   }
   voice.recover()
   mutedRef.current=true;setMuted(true)
   connectedRef.current=false;setConnected(false)
   return
  }
  begin(false,options.speaking)
 }
 const clearDraft=()=>{
  if(continuousRef.current||sendingRef.current)return
  updateDraft(null)
  voice.cancel()
 }
 const editDraft=(value:string)=>{
  if(continuousRef.current||sendingRef.current||draftRef.current===null)return
  updateDraft(value)
 }
 const sendDraft=async()=>{
  const submit=latest.current.onSendDraft
  if(!draftRef.current?.trim()||!submit||!latest.current.active||sendingRef.current)return
  const text=draftRef.current
  const version=epoch.current
  sendingRef.current=true;setSending(true);setError('')
  try{
   const accepted=await submit(text.trim())
   if(version===epoch.current){
    // Recognition can append more text while the submitted prefix is in flight.
    if(accepted)updateDraft(draftRef.current?.slice(text.length).trimStart()||null)
    else setError('chatSession.sendFailed')
   }
  }catch{if(version===epoch.current)setError('chatSession.sendFailed')}
  finally{if(version===epoch.current){sendingRef.current=false;setSending(false)}}
 }
 const stopReply=()=>{
  stopDigitalSpeech(options.projectId,options.sessionId)
  if(options.running)void options.onStop().catch(()=>setError('digitalPerson.homeInterruptFailed'))
 }
 return {connected,continuous:continuous&&connected,muted,playbackPaused,callMicMuted:continuous&&connected&&callMicMuted,error,notice:voice.notice,phase:voice.phase,text:voice.hasSpeech?voice.text:'',level:voice.level,readSpeechLevel:voice.readSpeechLevel,
  draft,sending,sendDraft,clearDraft,editDraft,toggle,
  startContinuous:()=>{wakeCall.current=false;begin(true)},
  startWakeContinuous:()=>{wakeCall.current=true;begin(true)},mute,end,stopReply}
}
