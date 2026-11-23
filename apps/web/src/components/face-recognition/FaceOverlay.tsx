import type {FaceObservation} from './runtime'
import {useLayoutEffect,useRef,useState,type RefObject} from 'react'
import './FaceRecognition.css'
export default function FaceOverlay({faces,showNames=true,showBoxes=true,showRelationship=false,videoRef,overlayRef,enrollmentHolding}:{faces:FaceObservation[];showNames?:boolean;showBoxes?:boolean;showRelationship?:boolean;videoRef:RefObject<HTMLVideoElement|null>;overlayRef?:RefObject<HTMLDivElement|null>;enrollmentHolding?:boolean}){
 const local=useRef<HTMLDivElement>(null),[bounds,setBounds]=useState({left:0,top:0,width:0,height:0})
 const root=overlayRef??local
 useLayoutEffect(()=>{
  const source=videoRef.current,parent=root.current?.parentElement
  if(!source||!parent)return
  const layout=()=>{
   // Use layout coordinates because the video and its overlay are zoomed together.
   const {offsetLeft,offsetTop,offsetWidth,offsetHeight,videoWidth,videoHeight}=source
   if(!videoWidth||!videoHeight||!offsetWidth||!offsetHeight)return
   const scale=Math.min(offsetWidth/videoWidth,offsetHeight/videoHeight),width=videoWidth*scale,height=videoHeight*scale
   setBounds({left:offsetLeft+(offsetWidth-width)/2,top:offsetTop+(offsetHeight-height)/2,width,height})
  }
  const observer=typeof ResizeObserver!=='undefined'?new ResizeObserver(layout):null
  observer?.observe(source);observer?.observe(parent);source.addEventListener('loadedmetadata',layout);source.addEventListener('resize',layout);window.addEventListener('resize',layout);layout()
  return()=>{observer?.disconnect();source.removeEventListener('loadedmetadata',layout);source.removeEventListener('resize',layout);window.removeEventListener('resize',layout)}
 },[videoRef,root])
 return <div ref={root} className="face-overlay" style={bounds} aria-hidden="true">{faces.map((face,i)=>{
  const [left,top,width,height]=enrollmentHolding===undefined?face.box:face.faceBox??face.box
  const state=enrollmentHolding===undefined?(face.person?' face-box--known':''):` face-box--enrollment${enrollmentHolding?' face-box--holding':''}`
  const label=[showNames?face.person?.name:'',showRelationship?face.person?.relationship:''].filter(Boolean).join(' · ')
  if(!showBoxes&&!label)return null
  return <div key={i} className={`face-box${state}${showBoxes?'':' face-box--no-outline'}`} style={{left:`${left*100}%`,top:`${top*100}%`,width:`${width*100}%`,height:`${height*100}%`}}>{label&&<span>{label}</span>}</div>
 })}</div>
}
