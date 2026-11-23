import {useCallback,useEffect,useRef,useState} from 'react'
import {faceApi} from '../../api/faces'
import {FaceWelcomePresence} from '../face-recognition/faceWelcomePresence'
import type {FaceWelcomeObserver,FaceWelcomeFrame} from '../face-recognition/useFaceRecognition'
import {playFaceWelcome,stopFaceWelcome} from './digitalPersonProactive'

interface Context {
 projectId:string
 sessionId:string
 active:boolean
 blocked:boolean
 muted:boolean
 privateSpeechFallback:string
}

const maxAge=2500

export function useFaceWelcome(context:Context){
 const latest=useRef(context);latest.current=context
 const presence=useRef<FaceWelcomePresence|null>(null)
 const frame=useRef<FaceWelcomeFrame|null>(null)
 const pending=useRef<AbortController|null>(null)
 const speaking=useRef<string|null>(null)
 const expiry=useRef<ReturnType<typeof setTimeout>|undefined>(undefined)
 const [text,setText]=useState('')
 const clear=useCallback(()=>{
  pending.current?.abort()
  pending.current=null
  clearTimeout(expiry.current)
  if(speaking.current)stopFaceWelcome(speaking.current)
  speaking.current=null
  setText('')
 },[])
 const reset=useCallback(()=>{
  presence.current?.reset()
  frame.current=null
  clear()
 },[clear])
 useEffect(()=>{
  const interrupt=()=>{if(document.hidden)reset()}
  document.addEventListener('visibilitychange',interrupt)
  window.addEventListener('offline',reset)
  window.addEventListener('online',reset)
  return()=>{
   reset()
   document.removeEventListener('visibilitychange',interrupt)
   window.removeEventListener('offline',reset)
   window.removeEventListener('online',reset)
  }
 },[reset,context.projectId,context.sessionId])
 useEffect(()=>{
  if(!context.active||context.blocked)clear()
  else if(context.muted&&speaking.current){
   stopFaceWelcome(speaking.current)
   speaking.current=null
  }
 },[clear,context.active,context.blocked,context.muted])
 const observe=useCallback<FaceWelcomeObserver>((sample)=>{
  if(!sample||document.hidden||!latest.current.active||navigator.onLine===false){reset();return}
  frame.current=sample
  presence.current??=new FaceWelcomePresence()
  const personId=presence.current.observe(sample.ids,sample.at,sample.awayMinutes)
  if(!personId||latest.current.blocked||pending.current||performance.now()-sample.at>maxAge)return
  const eventId=crypto.randomUUID(),request=new AbortController()
  pending.current=request
  const {projectId,sessionId}=latest.current
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
   if(result.speak&&!current.muted){
    speaking.current=eventId
    playFaceWelcome({projectId,sessionId,messageId:eventId,text:result.text,privateSpeechFallback:result.personalized?current.privateSpeechFallback:undefined})
   }
  }).catch(()=>{ // This return is consumed. Never queue an offline greeting.
  }).finally(()=>{
   clearTimeout(deadline)
   if(pending.current===request)pending.current=null
  })
 },[reset])
 return {text:context.active&&!context.blocked?text:'',observe}
}
