import {useEffect,useRef,useState} from 'react'
import {createCanvasLoop} from './avatar/canvasLoop'
import {advanceVoice} from './avatar/visualState'

/** Actual output frames only; the shared stage also supports skin-provided avatars. */
export default function DigitalPersonVoiceBackground({active,playing,level}:{active:boolean;playing:boolean;level:number}){
 const canvas=useRef<HTMLCanvasElement>(null),container=useRef<HTMLDivElement>(null)
 const input=useRef({playing,level});input.current={playing:active&&playing,level}
 const wake=useRef<(()=>void)|undefined>(undefined)
 const [started,setStarted]=useState(false)
 useEffect(()=>{if(active&&playing)setStarted(true);wake.current?.()},[active,playing,level])
 useEffect(()=>{
  if(!active||!started)return
  const stage=container.current
  let alive=true,dispose:(()=>void)|undefined
  void import('./avatar/voiceSilk').then(({createSilk})=>{
   if(!alive||!canvas.current)return
   const element=canvas.current,silk=createSilk(element)
   let values={level:0,activity:0},time=0
   const loop=createCanvasLoop(element,(_now,delta,reduced)=>{
    values=reduced?{level:0,activity:0}:advanceVoice(values,input.current.playing,input.current.level,delta)
    if(!input.current.playing&&values.activity<=.002)values={level:0,activity:0}
    time+=Math.min(100,delta)/1000*(.15+.30*values.activity+.16*values.level)
    stage?.style.setProperty('--voice-activity',String(values.activity))
    silk.draw(time,values.level,values.activity)
    return input.current.playing||values.activity>.002
   })
   const lost=(event:Event)=>{event.preventDefault();loop.dispose();if(stage)stage.style.setProperty('--voice-activity','0')}
   element.addEventListener('webglcontextlost',lost)
   wake.current=loop.invalidate
   dispose=()=>{wake.current=undefined;loop.dispose();element.removeEventListener('webglcontextlost',lost);silk.dispose()}
  }).catch(()=>{stage?.style.setProperty('--voice-activity','0')})
  return()=>{alive=false;dispose?.();stage?.style.setProperty('--voice-activity','0')}
 },[active,started])
 return <div ref={container} className="digital-home-voice-background" aria-hidden="true" data-layers="2"><canvas ref={canvas}/></div>
}
