import {useCallback,useEffect,useRef,useState,type CSSProperties,type RefObject,type PointerEvent,type KeyboardEvent} from 'react'

type Position={left:number;top:number;width?:number}
export const cameraPanelEdges=['n','e','s','w','ne','nw','se','sw'] as const
type Edge=typeof cameraPanelEdges[number]
function viewport(){
 const view=window.visualViewport
 return {left:(view?.offsetLeft??0)+8,top:(view?.offsetTop??0)+8,width:(view?.width??window.innerWidth)-16,height:(view?.height??window.innerHeight)-16}
}
/** Desktop camera geometry changes without replacing the video or its media session. */
export function useCameraPanelDrag(ref:RefObject<HTMLDivElement|null>,enabled:boolean){
 const [position,setPosition]=useState<Position|null>(null)
 const cleanup=useRef<(()=>void)|null>(null)
 const clamp=useCallback((value:Position)=>{
  const box=ref.current?.getBoundingClientRect(),view=viewport()
  const source=ref.current?.querySelector('video'),surface=ref.current?.querySelector('.video-preview-surface')?.getBoundingClientRect()
  const ratio=source?.videoWidth&&source.videoHeight?source.videoWidth/source.videoHeight:0
  // max-height may already compress the outer panel while its video overflows.
  // Measure chrome from the surface's top and symmetric padding instead.
  const inset=box&&surface?box.width-surface.width:18,overhead=box&&surface?surface.top-box.top+inset/2:50
  const maximum=Math.max(1,Math.min(800,view.width,ratio?(view.height-overhead)*ratio+inset:Infinity))
  const width=Math.min(maximum,Math.max(Math.min(280,maximum),value.width??box?.width??400))
  const height=ratio?(width-inset)/ratio+overhead:box?.height??0
  return {left:Math.max(view.left,Math.min(value.left,view.left+view.width-width)),top:Math.max(view.top,Math.min(value.top,view.top+view.height-height)),
   ...(value.width!==undefined||width!==(box?.width??400)?{width}:{})}
 },[ref])
 useEffect(()=>{
  if(!enabled){cleanup.current?.();let disposed=false;queueMicrotask(()=>{if(!disposed)setPosition(null)});return()=>{disposed=true}}
  const fit=()=>{
   if(window.innerWidth<=1023){cleanup.current?.();setPosition(null);return}
   const box=ref.current?.getBoundingClientRect()
   setPosition(current=>{
    if(current)return clamp(current)
    if(!box?.width||!box.height)return null
    const fitted=clamp({left:box.left,top:box.top})
    return fitted.width!==undefined||fitted.left!==box.left||fitted.top!==box.top?fitted:null
   })
  }
  const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(fit)
  if(ref.current)observer?.observe(ref.current)
  const source=ref.current?.querySelector('video')
  source?.addEventListener('loadedmetadata',fit);source?.addEventListener('resize',fit)
  window.addEventListener('resize',fit);window.visualViewport?.addEventListener('resize',fit)
  window.visualViewport?.addEventListener('scroll',fit)
  return()=>{cleanup.current?.();observer?.disconnect();source?.removeEventListener('loadedmetadata',fit);source?.removeEventListener('resize',fit);window.removeEventListener('resize',fit);window.visualViewport?.removeEventListener('resize',fit);window.visualViewport?.removeEventListener('scroll',fit)}
 },[enabled,ref,clamp])
 const edgeOf=(target:EventTarget)=>target instanceof Element?target.closest<HTMLElement>('[data-camera-resize]')?.dataset.cameraResize as Edge|undefined:undefined
 const canDrag=(target:EventTarget)=>enabled&&window.innerWidth>1023&&target instanceof Element&&Boolean(edgeOf(target)||target.closest('.video-preview-window--docked .video-preview-header'))&&!target.closest('button,input,select,a')
 const resize=(box:DOMRect,edge:Edge,dx:number,dy:number)=>{
  const current=ref.current?.getBoundingClientRect(),source=ref.current?.querySelector('video'),surface=ref.current?.querySelector('.video-preview-surface')?.getBoundingClientRect()
  if(!source?.videoWidth||!source.videoHeight||!surface?.height)return null
  const measured=current??box,ratio=source.videoWidth/source.videoHeight,inset=measured.width-surface.width,overhead=surface.top-measured.top+inset/2,view=viewport()
  const horizontal=edge.includes('w')?-dx:edge.includes('e')?dx:0,vertical=(edge.includes('n')?-dy:edge.includes('s')?dy:0)*ratio
  const delta=Math.abs(horizontal)>=Math.abs(vertical)?horizontal:vertical
  const availableWidth=edge.includes('w')?box.right-view.left:view.left+view.width-box.left
  const availableHeight=edge.includes('n')?box.bottom-view.top:view.top+view.height-box.top
  const maximum=Math.max(1,Math.min(800,availableWidth,(availableHeight-overhead)*ratio+inset))
  const width=Math.min(maximum,Math.max(Math.min(280,maximum),box.width+delta)),height=(width-inset)/ratio+overhead
  return clamp({width,left:edge.includes('w')?box.right-width:box.left,top:edge.includes('n')?box.bottom-height:box.top})
 }
 const onPointerDown=(event:PointerEvent<HTMLDivElement>)=>{
  if(event.button!==0||!canDrag(event.target))return
  const box=ref.current?.getBoundingClientRect();if(!box)return
  const edge=edgeOf(event.target)
  if(edge&&!ref.current?.querySelector('video')?.videoWidth)return
  event.preventDefault();cleanup.current?.()
  event.currentTarget.setPointerCapture?.(event.pointerId)
  const x=event.clientX,y=event.clientY,id=event.pointerId
  const move=(next:globalThis.PointerEvent)=>{
   if(next.pointerId!==id)return
   const dx=next.clientX-x,dy=next.clientY-y
   const nextPosition=edge?resize(box,edge,dx,dy):clamp({left:box.left+dx,top:box.top+dy,...(position?.width!==undefined?{width:box.width}:{})})
   if(nextPosition)setPosition(nextPosition)
  }
  const finish=(next:globalThis.PointerEvent)=>{if(next.pointerId===id)release()}
  const release=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',finish);window.removeEventListener('pointercancel',finish);cleanup.current=null}
  cleanup.current=release
  window.addEventListener('pointermove',move);window.addEventListener('pointerup',finish);window.addEventListener('pointercancel',finish)
 }
 const onKeyDown=(event:KeyboardEvent<HTMLDivElement>)=>{
  if(!canDrag(event.target))return
  const delta={ArrowLeft:[-8,0],ArrowRight:[8,0],ArrowUp:[0,-8],ArrowDown:[0,8]}[event.key]
  const box=ref.current?.getBoundingClientRect()
  if(delta&&box){
   event.preventDefault()
   const step=event.shiftKey?4:1,dx=delta[0]*step,dy=delta[1]*step,edge=edgeOf(event.target)
   const next=edge?resize(box,edge,dx,dy):clamp({left:box.left+dx,top:box.top+dy,...(position?.width!==undefined?{width:box.width}:{})})
   if(next)setPosition(next)
  }
 }
 return {onPointerDown,onKeyDown,style:position?{'--camera-panel-left':`${position.left}px`,'--camera-panel-top':`${position.top}px`,...(position.width!==undefined?{'--camera-panel-width':`${position.width}px`}:{})} as CSSProperties:undefined}
}
