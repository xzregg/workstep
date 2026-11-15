import {useEffect,useRef,useState} from 'react'
import {voiceWakeApi} from '../../api/digitalPerson'
import {primeSpeechOutput} from '../../utils/speechOutput'
import {useVoiceInput} from '../../hooks/useVoiceInput'
import {useWakeState} from './digitalPersonWakeState'
import {DialogueTurnDetector} from './dialogueTurnDetector'
import {stopDigitalSpeech} from './digitalPersonVoiceEvents'
interface Options{
 projectId:string;sessionId:string;active:boolean;running:boolean;speaking:boolean
 onSend:(text:string)=>Promise<boolean>;onStop:()=>Promise<boolean>
}
/** Voice capture and chat execution stay in the shared hooks; this owns turn taking. */
export function useDigitalPersonDialogue(options:Options){
 const [draft,setDraft]=useState('')
 const [connected,setConnected]=useState(false),[muted,setMuted]=useState(false),[sending,setSending]=useState(false),[error,setError]=useState('')
 const detector=useRef(new DialogueTurnDetector()),epoch=useRef(0),sendingRef=useRef(false)
 const latest=useRef(options);latest.current=options
 const connectedRef=useRef(false),mutedRef=useRef(false)
 connectedRef.current=connected;mutedRef.current=muted
 const activationPending=useWakeState(s=>s.activationPending)
 const resumeAfter=useRef(0),wasBusy=useRef(false),listenStarted=useRef(0)
 const voice=useVoiceInput({ownerKey:`digital-dialogue:${options.projectId}:${options.sessionId}`,projectId:options.projectId,
  disabled:!options.active||options.running||options.speaking,compact:false,value:'',cursor:0,onAudioFrame:samples=>{detector.current.observe(samples,performance.now());return detector.current.hasSpeech},onInsert:text=>{
   if(!detector.current.accepts(text)||!connectedRef.current||mutedRef.current||sendingRef.current||latest.current.running||latest.current.speaking)return
   setDraft(text.trim())
   const version=epoch.current,current=latest.current
   sendingRef.current=true;setSending(true);setError('')
   void (async()=>{
    try{
     if(version!==epoch.current||!connectedRef.current)return
     resumeAfter.current=performance.now()+600
     if(!await current.onSend(text.trim()))throw new Error('digitalPerson.homeSendFailed')
     if(version===epoch.current)setDraft('')
    }catch(reason){if(version===epoch.current){setError(reason instanceof Error?reason.message:String(reason));setMuted(true)}}
    finally{if(version===epoch.current){sendingRef.current=false;setSending(false)}}
   })()
  }})
 const capture=useRef(voice);capture.current=voice
 useEffect(()=>{
  if(!activationPending||!options.active)return
  useWakeState.setState({activationPending:false})
  listenStarted.current=0
  connectedRef.current=true;mutedRef.current=false
  setConnected(true);setMuted(false);setError('')
 },[activationPending,options.active])
 useEffect(()=>{
  if(voice.phase==='requesting')detector.current.reset()
  if(voice.phase==='recording'&&!listenStarted.current)listenStarted.current=performance.now()
  if(voice.phase==='error'){setMuted(true);setError(voice.error)}
 },[voice.phase,voice.error])
 useEffect(()=>{
  if(options.running||options.speaking){
   // A typed turn during keyword standby owns the microphone too; resume its short window after playback.
   if(connectedRef.current&&useWakeState.getState().listening){
    useWakeState.setState({listening:false,activationPending:false})
    mutedRef.current=false;setMuted(false)
   }
   wasBusy.current=true
   listenStarted.current=0
   detector.current.reset()
   return
  }
  if(wasBusy.current){wasBusy.current=false;resumeAfter.current=performance.now()+600}
  if(!connected||muted||sending||!options.active||document.hidden||voice.phase!=='idle')return
  const start=()=>{
   const current=latest.current
   if(connectedRef.current&&!mutedRef.current&&current.active&&!current.running&&!current.speaking&&!document.hidden)void capture.current.start()
  }
  const delay=Math.max(0,resumeAfter.current-performance.now())
  if(!delay){start();return}
  const timer=setTimeout(start,delay)
  return()=>clearTimeout(timer)
 },[connected,muted,sending,voice.phase,options.active,options.running,options.speaking])
 useEffect(()=>{
  if(!connected||muted)return
  const timer=setInterval(()=>{
   if(latest.current.running||latest.current.speaking||capture.current.phase!=='recording')return
   const now=performance.now()
   if(!detector.current.hasSpeech&&now-listenStarted.current>=15000){
    mutedRef.current=true;setMuted(true);capture.current.cancel()
    if(useWakeState.getState().keyword.trim())useWakeState.setState({listening:true,error:''})
    return
   }
   if(detector.current.tick(now)==='finish')void capture.current.finish()
  },100)
  return()=>clearInterval(timer)
 },[connected,muted])
 useEffect(()=>{
  const end=()=>{
   if(!document.hidden)return
   useWakeState.setState({listening:false,activationPending:false})
   connectedRef.current=false;setConnected(false);setMuted(false);capture.current.cancel()
   stopDigitalSpeech(options.projectId,options.sessionId)
  }
  document.addEventListener('visibilitychange',end)
  return()=>{
   epoch.current++;connectedRef.current=false;capture.current.cancel();stopDigitalSpeech(options.projectId,options.sessionId)
   document.removeEventListener('visibilitychange',end)
  }
 },[options.projectId,options.sessionId])
 useEffect(()=>{if(!options.active){connectedRef.current=false;setConnected(false);capture.current.cancel()}},[options.active])
 const toggle=()=>{
  if(connected&&!muted){useWakeState.setState({listening:false,activationPending:false});mutedRef.current=true;setMuted(true);voice.cancel();return}
  listenStarted.current=0
  primeSpeechOutput()
  useWakeState.setState({listening:false,activationPending:false})
  const version=epoch.current
  void voiceWakeApi.get().then(config=>{
   if(version===epoch.current&&connectedRef.current)useWakeState.setState({keyword:config.keyword,sensitivity:config.sensitivity})
  }).catch(()=>{})
  connectedRef.current=true;mutedRef.current=false;setConnected(true);setMuted(false);setError('')
  if(!options.running&&!options.speaking&&performance.now()>=resumeAfter.current)void voice.start()
 }
 const mute=()=>{useWakeState.setState({listening:false,activationPending:false});mutedRef.current=true;setMuted(true);voice.cancel()}
 const end=()=>{
  useWakeState.setState({listening:false,activationPending:false})
  epoch.current++;connectedRef.current=false;setConnected(false);setMuted(false);sendingRef.current=false;setSending(false);voice.cancel()
  stopDigitalSpeech(options.projectId,options.sessionId)
  if(options.running)void options.onStop().catch(()=>setError('digitalPerson.homeInterruptFailed'))
 }
 return {connected,muted,sending,error,draft,phase:voice.phase,text:detector.current.hasSpeech?voice.text:'',level:voice.level,toggle,mute,end}
}
