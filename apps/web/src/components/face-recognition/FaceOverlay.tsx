import type {FaceObservation} from './runtime'
import {useI18n} from '../../i18n'
import {useLayoutEffect,useRef,useState,type RefObject} from 'react'
import './FaceRecognition.css'
export default function FaceOverlay({faces,showNames=true,showBoxes=true,videoRef,enrollmentHolding}:{faces:FaceObservation[];showNames?:boolean;showBoxes?:boolean;videoRef:RefObject<HTMLVideoElement|null>;enrollmentHolding?:boolean}){
 const {t}=useI18n(),root=useRef<HTMLDivElement>(null),[bounds,setBounds]=useState({left:0,top:0,width:0,height:0})
 useLayoutEffect(()=>{
  const source=videoRef.current,parent=root.current?.parentElement
  if(!source||!parent)return
  const layout=()=>{
   const rect=source.getBoundingClientRect(),container=parent.getBoundingClientRect()
   if(!source.videoWidth||!source.videoHeight||!rect.width||!rect.height)return
   const scale=Math.min(rect.width/source.videoWidth,rect.height/source.videoHeight),width=source.videoWidth*scale,height=source.videoHeight*scale
   setBounds({left:rect.left-container.left+(rect.width-width)/2,top:rect.top-container.top+(rect.height-height)/2,width,height})
  }
  const observer=typeof ResizeObserver!=='undefined'?new ResizeObserver(layout):null
  observer?.observe(source);observer?.observe(parent);source.addEventListener('loadedmetadata',layout);source.addEventListener('resize',layout);window.addEventListener('resize',layout);layout()
  return()=>{observer?.disconnect();source.removeEventListener('loadedmetadata',layout);source.removeEventListener('resize',layout);window.removeEventListener('resize',layout)}
 },[videoRef])
 return <div ref={root} className="face-overlay" style={bounds} aria-hidden="true">{faces.map((face,i)=>{
  const [left,top,width,height]=enrollmentHolding===undefined?face.box:face.faceBox??face.box
  const state=enrollmentHolding===undefined?(face.person?' face-box--known':''):` face-box--enrollment${enrollmentHolding?' face-box--holding':''}`
  return <div key={i} className={`face-box${state}${showBoxes?'':' face-box--no-outline'}`} style={{left:`${left*100}%`,top:`${top*100}%`,width:`${width*100}%`,height:`${height*100}%`}}>{showNames&&<span>{face.person?.name||t('faceRecognition.unknown')}</span>}</div>
 })}</div>
}
