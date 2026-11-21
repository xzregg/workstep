import { localizeErrorDisplay } from '../i18n'
import {useEffect,useLayoutEffect,useRef,useState,type CSSProperties,type ReactNode,type RefObject,type PointerEvent as ReactPointerEvent} from 'react'
import {useI18n} from '../i18n'
import Button from './Button'
import Icon from './Icon'
import Spinner from './Spinner'
import './VideoPreviewWindow.css'

type Bounds={left:number;top:number;width:number;height:number}
type Point={x:number;y:number}
const edges=['n','e','s','w','ne','nw','se','sw'] as const
const controls=24
function viewport(){
 const view=window.visualViewport
 return {left:view?.offsetLeft??0,top:view?.offsetTop??0,width:view?.width??window.innerWidth,height:view?.height??window.innerHeight}
}
function size(width:number,ratio:number|null,border=1,point?:Point|null,automatic=true){
 const view=viewport()
 if(!ratio)return {width:Math.min(width,view.width-32),height:border+32}
 const anchorWidth=point?2*Math.min(point.x-view.left-8,view.left+view.width-8-point.x):Infinity
 const anchorHeight=point?2*Math.min(point.y-view.top-8-controls-border/2,view.top+view.height-24-point.y-border/2):Infinity
 const maxWidth=Math.max(1,Math.min(view.width-32,anchorWidth)),maxVideoHeight=Math.max(1,Math.min(automatic?view.height*.55:Infinity,view.height-32-controls-border,anchorHeight))
 const maximum=Math.min(maxWidth,maxVideoHeight*ratio+border)
 width=Math.min(maximum,Math.max(Math.min(160,maximum),width))
 return {width,height:(width-border)/ratio+border}
}
function clamp(bounds:Bounds):Bounds{
 const view=viewport()
 return {...bounds,left:Math.max(view.left+8,Math.min(view.left+view.width-bounds.width-8,bounds.left)),top:Math.max(view.top+controls+8,Math.min(view.top+view.height-bounds.height-24,bounds.top))}
}

/** Shared video surface: media ratio, viewport fitting and window gestures live here. */
export default function VideoPreviewWindow({open,onClose,label,closeLabel,videoRef:externalVideo,actions,error,getAnchor,overlay,presentation='window'}:{
 open:boolean;onClose:()=>void;label:string;closeLabel?:string;videoRef?:RefObject<HTMLVideoElement|null>
 presentation?:'window'|'panel';actions?:ReactNode;error?:string;getAnchor?:()=>Point|null;overlay?:ReactNode
}){
 const {t}=useI18n(),internalVideo=useRef<HTMLVideoElement>(null),video=externalVideo??internalVideo
 const panel=useRef<HTMLDivElement>(null),border=useRef(1)
 const cleanup=useRef<(()=>void)|null>(null),ratio=useRef<number|null>(null),moved=useRef(false),resized=useRef(false),anchor=useRef(getAnchor)
 anchor.current=getAnchor
 const docked=presentation==='panel'
 const previousPresentation=useRef(presentation)
 useLayoutEffect(()=>{if(previousPresentation.current===presentation)return;previousPresentation.current=presentation;cleanup.current?.();restore.current=null;moved.current=false;resized.current=false},[presentation])
 const lastTouch=useRef(0)
 const restore=useRef<Bounds|null>(null),lastTap=useRef<{time:number;x:number;y:number}|null>(null)
 const expand=()=>{
  if(docked||!bounds||!ratio.current)return
  cleanup.current?.();moved.current=true;resized.current=true
  if(restore.current){const previous=restore.current;restore.current=null;setBounds(clamp({...previous,...size(previous.width,ratio.current,border.current,null,false)}));return}
  restore.current=bounds
  const view=viewport(),dimensions=size(Infinity,ratio.current,border.current,null,false)
  setBounds(clamp({...dimensions,left:view.left+(view.width-dimensions.width)/2,top:view.top+(view.height-dimensions.height)/2}))
 }
 const [ready,setReady]=useState(false)
 const [bounds,setBounds]=useState<Bounds|null>(null)
 useLayoutEffect(()=>{
  if(!open){restore.current=null;lastTap.current=null;ratio.current=null;setReady(false);moved.current=false;resized.current=false;setBounds(null);return}
  const source=video.current
  const layout=()=>{
   if(source?.videoWidth&&source.videoHeight)ratio.current=source.videoWidth/source.videoHeight
   setReady(Boolean(ratio.current))
   const view=viewport(),style=panel.current?getComputedStyle(panel.current):null
   border.current=(parseFloat(style?.borderLeftWidth??'')+parseFloat(style?.borderRightWidth??''))||1
   setBounds(current=>{
    const point=!moved.current?anchor.current?.():null
    const dimensions=size(restore.current?Infinity:resized.current&&current?current.width:Math.min(320,view.width*.56),ratio.current,border.current,restore.current?null:point,!resized.current)
    const left=point?point.x-dimensions.width/2:current&&moved.current?current.left+(current.width-dimensions.width)/2:view.left+view.width-dimensions.width-16
    const top=point?point.y-dimensions.height/2:current&&moved.current?current.top:view.top+controls+16
    return clamp({...dimensions,left,top})
   })
  }
  let frame=0
  const resize=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(layout)}
  layout()
  source?.addEventListener('loadedmetadata',layout);source?.addEventListener('resize',layout)
  window.addEventListener('resize',resize);window.visualViewport?.addEventListener('resize',resize)
  return()=>{
   cancelAnimationFrame(frame);source?.removeEventListener('loadedmetadata',layout);source?.removeEventListener('resize',layout)
   window.removeEventListener('resize',resize);window.visualViewport?.removeEventListener('resize',resize)
  }
 },[open,video,presentation])
 useEffect(()=>{if(!open)cleanup.current?.();return()=>cleanup.current?.()},[open])
 const start=(event:ReactPointerEvent,edge?:typeof edges[number])=>{
  if(docked||event.button!==0||!bounds||(edge&&!ratio.current)||(event.target as HTMLElement).closest('button'))return
  if(event.pointerType==='touch')lastTouch.current=Date.now()
  event.preventDefault();cleanup.current?.()
  if(edge)restore.current=null
  moved.current=true
  if(edge)resized.current=true
  const initial=bounds,x=event.clientX,y=event.clientY
  let dragged=false
  const move=(next:PointerEvent)=>{
   if(next.pointerId!==event.pointerId)return
   const dx=next.clientX-x,dy=next.clientY-y
   if(Math.hypot(dx,dy)>6){dragged=true;lastTap.current=null;restore.current=null}
   if(!edge){setBounds(clamp({...initial,left:initial.left+dx,top:initial.top+dy}));return}
   const horizontal=edge.includes('e')?dx:edge.includes('w')?-dx:0
   const vertical=(edge.includes('s')?dy:edge.includes('n')?-dy:0)*ratio.current!
   const delta=Math.abs(horizontal)>=Math.abs(vertical)?horizontal:vertical
   const dimensions=size(initial.width+delta,ratio.current,border.current,null,false)
   setBounds(clamp({...dimensions,left:edge.includes('w')?initial.left+initial.width-dimensions.width:initial.left,top:edge.includes('n')?initial.top+initial.height-dimensions.height:initial.top}))
  }
  const finish=(next:PointerEvent)=>{
   if(next.pointerId!==event.pointerId)return
   release()
   if(next.type==='pointercancel'){lastTap.current=null;return}
   if(!edge&&!dragged&&event.pointerType==='touch'){
    const now=Date.now(),previous=lastTap.current
    if(previous&&now-previous.time<300&&Math.hypot(x-previous.x,y-previous.y)<24){lastTap.current=null;expand()}
    else lastTap.current={time:now,x,y}
   }
  }
  const release=()=>{
   window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',finish);window.removeEventListener('pointercancel',finish)
   cleanup.current=null
  }
  cleanup.current=release
  window.addEventListener('pointermove',move);window.addEventListener('pointerup',finish);window.addEventListener('pointercancel',finish)
 }
 return <div ref={panel} className={`video-preview-window${docked?' video-preview-window--docked':''}`} data-video-docked={presentation==='panel'?docked:undefined} data-video-ready={ready} data-video-expanded={Boolean(restore.current)} hidden={!open} style={docked?{'--video-preview-ratio':ratio.current??1} as CSSProperties:bounds??undefined} role="region" aria-label={label}>
  <div className="video-preview-header" tabIndex={docked?0:undefined}>
   {presentation==='panel'&&docked&&<span className="video-preview-header-title"><Icon name="camera" size={14}/>{label}</span>}
   {actions}
   <Button data-video-close variant="ghost" onClick={onClose} aria-label={closeLabel??t('common.close')}><Icon name="x" size={14}/></Button>
  </div>
  <div className="video-preview-content" data-video-drag tabIndex={0} role="button" aria-label={label} onDoubleClick={()=>{if(Date.now()-lastTouch.current<500)return;lastTap.current=null;expand()}} onKeyDown={event=>{
    if(event.key==='Enter'){event.preventDefault();expand();return}
    const delta={ArrowLeft:[-8,0],ArrowRight:[8,0],ArrowUp:[0,-8],ArrowDown:[0,8]}[event.key]
    if(delta&&bounds){event.preventDefault();moved.current=true;setBounds(clamp({...bounds,left:bounds.left+delta[0],top:bounds.top+delta[1]}))}
   }} onPointerDown={event=>start(event)}>
   <video ref={video} className="video-preview-media" autoPlay playsInline muted aria-label={label}/>
   {ready&&overlay}
   {!ready&&!error&&<div className="video-preview-loading"><Spinner size={16}/></div>}
   {error&&<p role="alert" className="video-preview-error">{localizeErrorDisplay(error)}</p>}
  </div>
  {edges.map(edge=><div key={edge} data-video-resize={edge} className={`video-preview-resize video-preview-resize--${edge}`} role="separator" tabIndex={0} aria-label={t(`taskDetail.resize.${edge}` as never)} onPointerDown={event=>start(event,edge)} onKeyDown={event=>{
   const delta={ArrowLeft:-8,ArrowRight:8,ArrowUp:-8,ArrowDown:8}[event.key]
   if(delta&&bounds&&ratio.current){event.preventDefault();moved.current=true;resized.current=true;setBounds(clamp({...bounds,...size(bounds.width+delta,ratio.current,border.current,null,false)}))}
  }}>{edge==='se'&&<span className="video-preview-resize-grip"/>}</div>) }
 </div>
}
