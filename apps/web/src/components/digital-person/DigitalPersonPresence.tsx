import {useEffect,useRef,useState} from 'react'
import {createCanvasLoop} from './avatar/canvasLoop'
import {advanceVoice} from './avatar/visualState'
import {advancePresence,initialPresence,presenceTarget} from './avatar/presenceMotion'
import type {AvatarSnapshot} from '../../avatars/runtime'
import type {createOrb} from './avatar/presenceOrb'
import type {createSilk} from './avatar/voiceSilk'

/** Built-in presence, behind the same public avatar boundary as custom skins. */
export default function DigitalPersonPresence({name,active,presentation,inputLevel=0}:{name:string;active:boolean;presentation:AvatarSnapshot;inputLevel?:number}){
 const orb=useRef<HTMLCanvasElement>(null),silk=useRef<HTMLCanvasElement>(null)
 const latest=useRef({presentation,inputLevel});latest.current={presentation,inputLevel}
 const wake=useRef<(()=>void)|undefined>(undefined),[fallback,setFallback]=useState(false)
 useEffect(()=>{
  if(!active||fallback)return
  let alive=true,dispose:(()=>void)|undefined
  void Promise.all([import('./avatar/presenceOrb'),import('./avatar/voiceSilk')]).then(([orbModule,silkModule])=>{
   if(!alive||!orb.current||!silk.current)return
   let sphere:ReturnType<typeof createOrb>|undefined,ribbon:ReturnType<typeof createSilk>|undefined
   try{
    const canvas=orb.current,light=silk.current
    sphere=orbModule.createOrb(canvas);ribbon=silkModule.createSilk(light)
    const orbRenderer=sphere,silkRenderer=ribbon
    let visual={...initialPresence},voice={level:0,activity:0},time=0
    const loop=createCanvasLoop(canvas,(_now,delta,reduced)=>{
     const {presentation:frame,inputLevel:mic}=latest.current,phase=presenceTarget(frame.phase)
     visual=advancePresence(visual,phase,reduced?0:delta)
     const speaking=frame.speech.playing,listening=phase==='listening'
     voice=reduced?{level:0,activity:0}:advanceVoice(voice,speaking||listening,speaking?frame.speech.level:listening?mic:0,delta)
     if(!reduced)time+=Math.min(delta,100)/1000
     const dark=window.matchMedia('(max-width:1023px)').matches||document.documentElement.dataset.theme==='dark'
     orbRenderer.draw(time,reduced?{...visual,pulse:0}:visual,voice.level,['idle','listening','thinking','working','speaking'].indexOf(phase),dark?'dark':'light')
     silkRenderer.draw(time*.3,voice.level,reduced?0:speaking?.9:phase==='working'?.5:phase==='thinking'?.24:.18)
     light.style.opacity=String(reduced?.12:speaking?.94:.48)
     canvas.dataset.presencePhase=phase;canvas.dataset.motion=reduced?'still':'animated'
     return true
    })
    const lost=(event:Event)=>{event.preventDefault();loop.dispose();if(alive)setFallback(true)}
    canvas.addEventListener('webglcontextlost',lost);light.addEventListener('webglcontextlost',lost)
    wake.current=loop.invalidate
    dispose=()=>{wake.current=undefined;loop.dispose();canvas.removeEventListener('webglcontextlost',lost);light.removeEventListener('webglcontextlost',lost);orbRenderer.dispose();silkRenderer.dispose()}
   }catch{sphere?.dispose();ribbon?.dispose();if(alive)setFallback(true)}
  }).catch(()=>{if(alive)setFallback(true)})
  return()=>{alive=false;dispose?.()}
 },[active,fallback])
 useEffect(()=>wake.current?.(),[presentation,inputLevel])
 return <div className="digital-presence-orb" data-fallback={fallback||!active?true:undefined} role="img" aria-label={name}>
  <span className="digital-home-avatar-eyes" data-avatar-eyes aria-hidden="true"/>
  {fallback||!active?<div className="digital-presence-static"/>:<><canvas ref={silk} className="digital-presence-silk" aria-hidden="true"/><canvas ref={orb} className="digital-presence-particles" aria-hidden="true"/></>}
 </div>
}
