import {useEffect,useRef,useState} from 'react'
import {createCanvasLoop} from './avatar/canvasLoop'
import {advanceVoice} from './avatar/visualState'
import type {OrbPhase} from './avatar/particlePalette'
import type {AvatarSnapshot} from '../../avatars/runtime'
import type {createOrb,PresenceReply} from './avatar/presenceOrb'


/** Built-in presence, behind the same public avatar boundary as custom skins. */
export default function DigitalPersonPresence({name,active,presentation,phase,inputLevel=0,metered=true,reply}:{name:string;active:boolean;presentation:AvatarSnapshot;phase:OrbPhase;inputLevel?:number;metered?:boolean;reply?:PresenceReply}){
 const orb=useRef<HTMLCanvasElement>(null)
 const latest=useRef({presentation,phase,inputLevel,metered,reply});latest.current={presentation,phase,inputLevel,metered,reply}
 const wake=useRef<(()=>void)|undefined>(undefined),[fallback,setFallback]=useState(false)
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
    let voice={level:0,activity:0}
    const loop=createCanvasLoop(canvas,(_now,delta,reduced)=>{
     const {presentation:frame,phase:current,inputLevel:mic,metered:hasLevel,reply}=latest.current
     const still=reduced||frame.reducedMotion
     voice=advanceVoice(voice,frame.speech.playing,frame.speech.level,delta)
     canvas.dataset.presencePhase=frame.phase
     canvas.dataset.motion=still?'still':'animated'
     return renderer.draw(delta,current,hasLevel?voice.level:0,still,mic,frame.activityId,reply)
    })
    const lost=(event:Event)=>{event.preventDefault();loop.dispose();if(alive)setFallback(true)}
    canvas.addEventListener('webglcontextlost',lost)
    wake.current=loop.invalidate
    dispose=()=>{wake.current=undefined;loop.dispose();canvas.removeEventListener('webglcontextlost',lost);renderer.dispose()}
   }catch{sphere?.dispose();if(alive)setFallback(true)}
  }).catch(()=>{if(alive)setFallback(true)})
  return()=>{alive=false;dispose?.()}
 },[active,fallback])
 useEffect(()=>wake.current?.(),[presentation,phase,inputLevel,metered,reply?.id,reply?.status])
 return <div className="digital-presence-orb" data-wake-breath={active&&fallback&&phase==='wake'&&!presentation.reducedMotion||undefined} data-fallback={active&&fallback||undefined} role="img" aria-label={name}>
  <span className="digital-home-avatar-eyes" data-avatar-eyes aria-hidden="true"/>
  {active&&(fallback?<div className="digital-presence-static"/>:<canvas ref={orb} className="digital-presence-particles" aria-hidden="true"/>)}
 </div>
}
