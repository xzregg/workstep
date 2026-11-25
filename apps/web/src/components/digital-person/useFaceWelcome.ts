import {useCallback,useEffect,useRef,useState} from 'react'
import {faceApi} from '../../api/faces'
import {FaceWelcomePresence} from '../face-recognition/faceWelcomePresence'
import type {FaceWelcomeObserver,FaceWelcomeFrame} from '../face-recognition/useFaceRecognition'
import {playFaceWelcome,stopFaceWelcome} from './digitalPersonProactive'
import {homePreferenceScope} from './homePreferences'

interface Context {
 projectId:string
 sessionId:string
 active:boolean
 blocked:boolean
 speechBusy:boolean
 muted:boolean
 privateSpeechFallback:string
}

const maxAge=2500

export function useFaceWelcome(context:Context){
 const latest=useRef(context);latest.current=context
 const storageKey=`${homePreferenceScope(context.projectId)}:face-welcome-away`
 const presence=useRef<FaceWelcomePresence|null>(null)
 const frame=useRef<FaceWelcomeFrame|null>(null)
 const closedAt=useRef<number|null>(null)
 const cameraOffMs=useRef(0)
 const observed=useRef(false)
 const lastSavedAt=useRef<number|null>(null)
 const pending=useRef<AbortController|null>(null)
 const speaking=useRef<string|null>(null)
 const expiry=useRef<ReturnType<typeof setTimeout>|undefined>(undefined)
 const [text,setText]=useState('')
 const saveTime=useCallback((at:number)=>{
  try{localStorage.setItem(storageKey,String(at))}catch{ /* Storage may be unavailable. */ }
  lastSavedAt.current=at
 },[storageKey])
 const clear=useCallback(()=>{
  pending.current?.abort()
  pending.current=null
  clearTimeout(expiry.current)
  if(speaking.current)stopFaceWelcome(speaking.current)
  speaking.current=null
  setText('')
 },[])
 const resetStream=useCallback(()=>{
  presence.current?.reset()
  frame.current=null
  clear()
 },[clear])
 const reset=useCallback(()=>{
  closedAt.current=null
  cameraOffMs.current=0
  observed.current=false
  lastSavedAt.current=null
  resetStream()
 },[resetStream])
 const cameraClosed=useCallback(()=>{
  if(!latest.current.active)return
  closedAt.current??=Date.now()
  saveTime(closedAt.current)
 },[saveTime])
 const cameraOpened=useCallback(()=>{
  if(closedAt.current!==null){
   cameraOffMs.current=Math.max(0,Date.now()-closedAt.current)
   closedAt.current=null
  }
  observed.current=false
 },[])
 useEffect(()=>{
  if(context.active){
   try{
    const stored=Number(localStorage.getItem(storageKey))
    if(Number.isFinite(stored)&&stored>0&&stored<=Date.now())closedAt.current=stored
   }catch{ /* Keep in-memory camera timing when persistence is unavailable. */ }
   if(!document.hidden)cameraOpened()
  }
  const leave=()=>{
   if(observed.current)cameraClosed()
   cameraOffMs.current=0
   resetStream()
  }
  const interrupt=()=>{
   if(document.hidden)leave()
   else cameraOpened()
  }
  const restore=(event:PageTransitionEvent)=>{
   if(event.persisted&&!document.hidden)cameraOpened()
  }
  document.addEventListener('visibilitychange',interrupt)
  window.addEventListener('pagehide',leave)
  window.addEventListener('pageshow',restore)
  window.addEventListener('offline',reset)
  window.addEventListener('online',reset)
  return()=>{
   reset()
   document.removeEventListener('visibilitychange',interrupt)
   window.removeEventListener('pagehide',leave)
   window.removeEventListener('pageshow',restore)
   window.removeEventListener('offline',reset)
   window.removeEventListener('online',reset)
  }
 },[reset,resetStream,cameraClosed,cameraOpened,storageKey,context.active,context.sessionId])
 useEffect(()=>{
  if(!context.active)reset()
  else if(context.blocked)clear()
  else if(context.muted&&speaking.current){
   stopFaceWelcome(speaking.current)
   speaking.current=null
  }
 },[reset,clear,context.active,context.blocked,context.muted])
 const observe=useCallback<FaceWelcomeObserver>((sample)=>{
  if(!sample){resetStream();return}
  if(document.hidden||!latest.current.active||navigator.onLine===false){reset();return}
  if(performance.now()-sample.at>maxAge)return
  // The last fresh frame also survives browser exits that omit pagehide.
  const now=Date.now()
  if(lastSavedAt.current===null||now-lastSavedAt.current>=5000||now<lastSavedAt.current)saveTime(now)
  observed.current=true
  frame.current=sample
  presence.current??=new FaceWelcomePresence()
  const personId=presence.current.observe(sample.ids,sample.at,sample.awayMinutes,cameraOffMs.current)
  cameraOffMs.current=0
  if(!personId||latest.current.blocked||pending.current)return
  const eventId=crypto.randomUUID(),request=new AbortController()
  pending.current=request
  const {projectId,sessionId,speechBusy}=latest.current
  const deadline=setTimeout(()=>request.abort(),maxAge)
  void faceApi.offerWelcome({event_id:eventId,person_id:personId,revision:sample.revision},request.signal).then(result=>{
   const current=latest.current,fresh=frame.current
   if(!result||request.signal.aborted||!current.active||current.blocked||document.hidden||
      current.projectId!==projectId||current.sessionId!==sessionId||!fresh||
      fresh.revision!==sample.revision||fresh.ids.length!==1||fresh.ids[0]!==personId||
      performance.now()-fresh.at>maxAge)return
   setText(result.text)
   clearTimeout(expiry.current)
   expiry.current=setTimeout(()=>setText(''),8000)
   if(result.speak&&!speechBusy&&!current.speechBusy&&!current.muted){
    speaking.current=eventId
    playFaceWelcome({projectId,sessionId,messageId:eventId,text:result.text,privateSpeechFallback:result.personalized?current.privateSpeechFallback:undefined})
   }
  }).catch(()=>{ // This return is consumed. Never queue an offline greeting.
  }).finally(()=>{
   clearTimeout(deadline)
   if(pending.current===request)pending.current=null
  })
 },[reset,resetStream,saveTime])
 return {text:context.active&&!context.blocked?text:'',observe,cameraClosed,cameraOpened}
}
