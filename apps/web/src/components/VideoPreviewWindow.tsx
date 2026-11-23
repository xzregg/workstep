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
const floatingToolbarHeight=()=>window.innerWidth>1023?24:0
function viewport(){
 const view=window.visualViewport
 return {left:view?.offsetLeft??0,top:view?.offsetTop??0,width:view?.width??window.innerWidth,height:view?.height??window.innerHeight}
}
function size(width:number,ratio:number|null,border=1,point?:Point|null,automatic=true){
 const view=viewport()
 const toolbar=floatingToolbarHeight()
 if(!ratio)return {width:Math.min(width,view.width-32),height:border+(toolbar?32:40)}
 const anchorWidth=point?2*Math.min(point.x-view.left-8,view.left+view.width-8-point.x):Infinity
 const anchorHeight=point?2*Math.min(point.y-view.top-8-toolbar-border/2,view.top+view.height-24-point.y-border/2):Infinity
 const maxWidth=Math.max(1,Math.min(view.width-32,anchorWidth)),maxVideoHeight=Math.max(1,Math.min(automatic?view.height*.55:Infinity,view.height-32-toolbar-border,anchorHeight))
 const maximum=Math.min(maxWidth,maxVideoHeight*ratio+border)
 width=Math.min(maximum,Math.max(Math.min(160,maximum),width))
 return {width,height:(width-border)/ratio+border}
}
function clamp(bounds:Bounds):Bounds{
 const view=viewport()
 return {...bounds,left:Math.max(view.left+8,Math.min(view.left+view.width-bounds.width-8,bounds.left)),top:Math.max(view.top+floatingToolbarHeight()+8,Math.min(view.top+view.height-bounds.height-24,bounds.top))}
}

/** Shared video surface: media ratio, viewport fitting and window gestures live here. */
export default function VideoPreviewWindow({open,onClose,label,closeLabel,videoRef:externalVideo,actions,error,getAnchor,overlay,status,presentation='window'}:{
 open:boolean;onClose:()=>void;label:string;closeLabel?:string;videoRef?:RefObject<HTMLVideoElement|null>
 presentation?:'window'|'panel';actions?:ReactNode;error?:string;getAnchor?:()=>Point|null;overlay?:ReactNode;status?:ReactNode
}){
 const {t}=useI18n(),internalVideo=useRef<HTMLVideoElement>(null),video=externalVideo??internalVideo
 const panel=useRef<HTMLDivElement>(null),surface=useRef<HTMLDivElement>(null),border=useRef(1)
 const cleanup=useRef<(()=>void)|null>(null),ratio=useRef<number|null>(null),moved=useRef(false),resized=useRef(false),anchor=useRef(getAnchor)
 anchor.current=getAnchor
 const docked=presentation==='panel'
 const previousPresentation=useRef(presentation)
 useLayoutEffect(()=>{if(previousPresentation.current===presentation)return;previousPresentation.current=presentation;cleanup.current?.();moved.current=false;resized.current=false},[presentation])
 const lastTouch=useRef(0),lastDrag=useRef(false)
 const lastTap=useRef<{time:number;x:number;y:number}|null>(null)
 const [zoomOrigin,setZoomOrigin]=useState<string|null>(null)
 const toggleZoom=(point?:Point)=>{
  if(!ratio.current)return
  const rect=surface.current?.getBoundingClientRect()
  const percent=(offset:number,span:number)=>100*Math.max(0,Math.min(1,offset/span))
  const origin=point&&rect?.width&&rect.height
   ? `${percent(point.x-rect.left,rect.width)}% ${percent(point.y-rect.top,rect.height)}%`
   : '50% 50%'
  setZoomOrigin(current=>current===null?origin:null)
 }
 const [ready,setReady]=useState(false)
 const [bounds,setBounds]=useState<Bounds|null>(null)
 useLayoutEffect(()=>{
  if(!open){setZoomOrigin(null);lastTap.current=null;lastDrag.current=false;lastTouch.current=0;ratio.current=null;setReady(false);moved.current=false;resized.current=false;setBounds(null);return}
  const source=video.current
  const layout=()=>{
   if(source?.videoWidth&&source.videoHeight)ratio.current=source.videoWidth/source.videoHeight
   setReady(Boolean(ratio.current))
   const view=viewport(),style=panel.current?getComputedStyle(panel.current):null
   border.current=(parseFloat(style?.borderLeftWidth??'')+parseFloat(style?.borderRightWidth??''))||1
   setBounds(current=>{
    const point=!moved.current?anchor.current?.():null
    const dimensions=size(resized.current&&current?current.width:Math.min(320,view.width*.56),ratio.current,border.current,point,!resized.current)
    const left=point?point.x-dimensions.width/2:current&&moved.current?current.left+(current.width-dimensions.width)/2:view.left+view.width-dimensions.width-16
    const top=point?point.y-dimensions.height/2:current&&moved.current?current.top:view.top+floatingToolbarHeight()+16
    return clamp({...dimensions,left,top})
   })
  }
  let frame=0
  const resize=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(layout)}
  const loaded=()=>{setZoomOrigin(null);lastTap.current=null;layout()}
  layout()
  source?.addEventListener('loadedmetadata',loaded);source?.addEventListener('resize',layout)
  window.addEventListener('resize',resize);window.visualViewport?.addEventListener('resize',resize)
  return()=>{
   cancelAnimationFrame(frame);source?.removeEventListener('loadedmetadata',loaded);source?.removeEventListener('resize',layout)
   window.removeEventListener('resize',resize);window.visualViewport?.removeEventListener('resize',resize)
  }
 },[open,video,presentation])
 useEffect(()=>{if(!open)cleanup.current?.();return()=>cleanup.current?.()},[open])
 const start=(event:ReactPointerEvent,edge?:typeof edges[number])=>{
  const touch=event.pointerType==='touch'
  if(event.button!==0||!bounds||(edge&&!ratio.current)||(docked&&(!touch||edge))||(event.target as HTMLElement).closest('button'))return
  if(touch)lastTouch.current=Date.now()
  if(!docked)event.preventDefault()
  cleanup.current?.()
  lastDrag.current=false
  if(edge)lastTap.current=null
  const initial=bounds,x=event.clientX,y=event.clientY
  let dragged=false
  const move=(next:PointerEvent)=>{
   if(next.pointerId!==event.pointerId)return
   const dx=next.clientX-x,dy=next.clientY-y
   if(!dragged&&Math.hypot(dx,dy)<=6)return
   dragged=true;lastDrag.current=true;lastTap.current=null
   if(docked)return
   moved.current=true
   if(!edge){setBounds(clamp({...initial,left:initial.left+dx,top:initial.top+dy}));return}
   resized.current=true
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
   if(!edge&&!dragged&&touch&&ratio.current){
    const now=Date.now(),previous=lastTap.current
    if(previous&&now-previous.time<300&&Math.hypot(x-previous.x,y-previous.y)<24){lastTap.current=null;toggleZoom({x,y})}
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
 return <div ref={panel} className={`video-preview-window${docked?' video-preview-window--docked':''}`} data-video-docked={presentation==='panel'?docked:undefined} data-video-ready={ready} hidden={!open} style={docked?{'--video-preview-ratio':ratio.current??1} as CSSProperties:bounds??undefined} role="region" aria-label={label}>
  {docked&&<div className="video-preview-header" tabIndex={0}>
   <span className="video-preview-header-title"><Icon name="camera" size={14}/>{label}</span>
  </div>}
  <div className="video-preview-surface">
   <div ref={surface} className="video-preview-content" data-video-drag tabIndex={0} role="button" aria-label={label} aria-pressed={zoomOrigin!==null} onDoubleClick={event=>{
    if(lastDrag.current||Date.now()-lastTouch.current<500)return
    lastTap.current=null;toggleZoom({x:event.clientX,y:event.clientY})
   }} onKeyDown={event=>{
    if(event.key==='Enter'||event.key===' '){event.preventDefault();if(!event.repeat)toggleZoom();return}
    const delta={ArrowLeft:[-8,0],ArrowRight:[8,0],ArrowUp:[0,-8],ArrowDown:[0,8]}[event.key]
    if(!docked&&delta&&bounds){event.preventDefault();moved.current=true;setBounds(clamp({...bounds,left:bounds.left+delta[0],top:bounds.top+delta[1]}))}
   }} onPointerDown={event=>start(event)}>
    <div className="video-preview-picture" style={zoomOrigin?{transformOrigin:zoomOrigin}:undefined}>
     <video ref={video} className="video-preview-media" autoPlay playsInline muted aria-label={label}/>
     {ready&&overlay}
    </div>
    {ready&&status}
    {!ready&&!error&&<div className="video-preview-loading"><Spinner size={16}/></div>}
    {error&&<p role="alert" className="video-preview-error">{localizeErrorDisplay(error)}</p>}
   </div>
   <div className="video-preview-controls">
    {actions}
    <Button data-video-close variant="ghost" onClick={onClose} aria-label={closeLabel??t('common.close')}><Icon name="x" size={14}/></Button>
   </div>
  </div>
  {edges.map(edge=><div key={edge} data-video-resize={edge} className={`video-preview-resize video-preview-resize--${edge}`} role="separator" tabIndex={0} aria-label={t(`taskDetail.resize.${edge}` as never)} onPointerDown={event=>start(event,edge)} onKeyDown={event=>{
   const delta={ArrowLeft:-8,ArrowRight:8,ArrowUp:-8,ArrowDown:8}[event.key]
   if(delta&&bounds&&ratio.current){event.preventDefault();moved.current=true;resized.current=true;setBounds(clamp({...bounds,...size(bounds.width+delta,ratio.current,border.current,null,false)}))}
  }}>{edge==='se'&&<span className="video-preview-resize-grip"/>}</div>) }
 </div>
}
