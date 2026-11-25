import {useLayoutEffect,useMemo,useRef,useState,useSyncExternalStore,type ReactNode} from 'react'
import {createAvatarSource,createAvatarSnapshot,type AvatarInput,type AvatarSnapshot} from '../avatars/runtime'
import {SkinAvatarRenderer} from './SkinExtensions'
import './AvatarPresentation.css'

const reducedQuery='(prefers-reduced-motion: reduce)'
function subscribeReduced(listener:()=>void){
 const media=window.matchMedia(reducedQuery)
 media.addEventListener('change',listener)
 return()=>media.removeEventListener('change',listener)
}
const getReduced=()=>window.matchMedia(reducedQuery).matches

/** Public presentation boundary shared by the built-in rig and skin-provided characters. */
export default function AvatarPresentation({projectId,sessionId,name,active=true,paused=false,phase,callState,inputLevel,metered,activityId,speaking,level,emotion,intensity,affinity,fallback}:AvatarInput&{
 projectId:string;sessionId:string;name:string;active?:boolean;paused?:boolean;fallback:(state:AvatarSnapshot)=>ReactNode
}){
 const prefersReducedMotion=useSyncExternalStore(subscribeReduced,getReduced,getReduced)
 const reducedMotion=prefersReducedMotion||paused
 const input=useMemo<AvatarInput>(()=>({phase:active?phase:'idle',callState:active?callState:'idle',inputLevel:active?inputLevel:0,metered,activityId,speaking:active&&speaking,level,emotion,intensity,affinity,reducedMotion}),[active,phase,callState,inputLevel,metered,activityId,speaking,level,emotion,intensity,affinity,reducedMotion])
 const latest=useRef(input);latest.current=input
 const source=useRef<ReturnType<typeof createAvatarSource>|null>(null)
 const [snapshot,setSnapshot]=useState(()=>createAvatarSnapshot({projectId,sessionId},input,null,performance.now()))
 useLayoutEffect(()=>{
  if(!active)return
  const current=createAvatarSource({projectId,sessionId});source.current=current
  setSnapshot(current.update(latest.current))
  return()=>{source.current=null;current.dispose()}
 },[projectId,sessionId,active])
 useLayoutEffect(()=>{
  if(source.current)setSnapshot(source.current.update(input))
  else setSnapshot(previous=>createAvatarSnapshot({projectId,sessionId},input,previous.projectId===projectId&&previous.sessionId===sessionId?previous:null,performance.now()))
 },[input,projectId,sessionId])
 const state=snapshot.projectId===projectId&&snapshot.sessionId===sessionId?snapshot:createAvatarSnapshot({projectId,sessionId},input,null,performance.now())
 return <div className="avatar-presentation" data-ui="avatar" data-avatar-phase={state.phase} data-avatar-call-state={state.callState} data-avatar-action={state.action}>
  <SkinAvatarRenderer state={state} name={name} fallback={fallback(state)}/>
 </div>
}
