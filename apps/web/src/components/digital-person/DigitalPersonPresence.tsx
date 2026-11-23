import {useEffect,useLayoutEffect,useRef,useState} from 'react'
import {createCanvasLoop} from './avatar/canvasLoop'
import type {OrbPhase} from './avatar/particlePalette'
import type {AvatarSnapshot} from '../../avatars/runtime'
import type {createOrb,PresenceReply} from './avatar/presenceOrb'


/** Built-in presence, behind the same public avatar boundary as custom skins. */
export default function DigitalPersonPresence({name,active,presentation,phase,readSpeechLevel,metered=true,reply}:{name:string;active:boolean;presentation:AvatarSnapshot;phase:OrbPhase;readSpeechLevel?:()=>number;metered?:boolean;reply?:PresenceReply}){
 const orb=useRef<HTMLCanvasElement>(null)
 const latest=useRef({presentation,phase,readSpeechLevel,metered,reply})
 const wake=useRef<(()=>void)|undefined>(undefined),[fallback,setFallback]=useState(false)
 useLayoutEffect(()=>{
  latest.current={presentation,phase,readSpeechLevel,metered,reply}
  wake.current?.()
 },[presentation,phase,readSpeechLevel,metered,reply])
 useEffect(()=>{
  if(!active||fallback)return
  let alive=true,dispose:(()=>void)|undefined
  void import('./avatar/presenceOrb').then(orbModule=>{
   if(!alive||!orb.current)return
   let sphere:ReturnType<typeof createOrb>|undefined
   try{
    const canvas=orb.current
    const androidWebView=Boolean(window.WorkStepAndroid)||/\bAndroid\b[^)]*;\s*wv\b/i.test(window.navigator.userAgent)
    const renderer=sphere=orbModule.createOrb(canvas,androidWebView)
    const loop=createCanvasLoop(canvas,(_now,delta,reduced)=>{
     const {presentation:frame,phase:current,readSpeechLevel:readMic,metered:hasLevel,reply}=latest.current
     const still=reduced||frame.reducedMotion
     canvas.dataset.presencePhase=frame.phase
     canvas.dataset.motion=still?'still':'animated'
     const mic=!still&&current==='listening'?(readMic?.()??0):0
     return renderer.draw(delta,current,hasLevel&&frame.speech.playing?frame.speech.level:0,still,mic,frame.activityId,reply)
    })
    const lost=(event:Event)=>{event.preventDefault();loop.dispose();if(alive)setFallback(true)}
    canvas.addEventListener('webglcontextlost',lost)
    wake.current=loop.invalidate
    dispose=()=>{wake.current=undefined;loop.dispose();canvas.removeEventListener('webglcontextlost',lost);renderer.dispose()}
   }catch{sphere?.dispose();if(alive)setFallback(true)}
  }).catch(()=>{if(alive)setFallback(true)})
  return()=>{alive=false;dispose?.()}
 },[active,fallback])
 return <div className="digital-presence-orb" data-wake-breath={phase==='wake'||undefined}
  data-fallback-motion={active&&fallback&&!presentation.reducedMotion||undefined} data-fallback={active&&fallback||undefined} role="img" aria-label={name}>
  <span className="digital-home-avatar-eyes" data-avatar-eyes aria-hidden="true"/>
  {active&&(fallback?<div className="digital-presence-static"/>:<canvas ref={orb} className="digital-presence-particles" aria-hidden="true"/>)}
 </div>
}
