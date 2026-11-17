import {useCallback,useEffect,useRef,useState,type CSSProperties,type RefObject,type PointerEvent,type KeyboardEvent} from 'react'

type Position={left:number;top:number}
/** Move the whole camera panel without changing its video element or media session. */
export function useCameraPanelDrag(ref:RefObject<HTMLDivElement|null>,enabled:boolean){
 const [position,setPosition]=useState<Position|null>(null)
 const cleanup=useRef<(()=>void)|null>(null)
 const clamp=useCallback((value:Position)=>{
  const box=ref.current?.getBoundingClientRect(),view=window.visualViewport
  const left=view?.offsetLeft??0,top=view?.offsetTop??0,width=view?.width??window.innerWidth,height=view?.height??window.innerHeight
  return {left:Math.max(left+8,Math.min(value.left,left+width-(box?.width??0)-8)),top:Math.max(top+8,Math.min(value.top,top+height-(box?.height??0)-8))}
 },[ref])
 useEffect(()=>{
  if(!enabled){cleanup.current?.();let disposed=false;queueMicrotask(()=>{if(!disposed)setPosition(null)});return()=>{disposed=true}}
  const fit=()=>setPosition(current=>current?clamp(current):current)
  const observer=typeof ResizeObserver==='undefined'?null:new ResizeObserver(fit)
  if(ref.current)observer?.observe(ref.current)
  window.addEventListener('resize',fit);window.visualViewport?.addEventListener('resize',fit)
  return()=>{cleanup.current?.();observer?.disconnect();window.removeEventListener('resize',fit);window.visualViewport?.removeEventListener('resize',fit)}
 },[enabled,ref,clamp])
 const canDrag=(target:EventTarget)=>enabled&&target instanceof Element&&Boolean(target.closest('.video-preview-window--docked .video-preview-header'))&&!target.closest('button,input,select,a')
 const onPointerDown=(event:PointerEvent<HTMLDivElement>)=>{
  if(event.button!==0||!canDrag(event.target))return
  const box=ref.current?.getBoundingClientRect();if(!box)return
  event.preventDefault();cleanup.current?.()
  const x=event.clientX,y=event.clientY,id=event.pointerId
  const move=(next:globalThis.PointerEvent)=>{if(next.pointerId===id)setPosition(clamp({left:box.left+next.clientX-x,top:box.top+next.clientY-y}))}
  const finish=(next:globalThis.PointerEvent)=>{if(next.pointerId===id)release()}
  const release=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',finish);window.removeEventListener('pointercancel',finish);cleanup.current=null}
  cleanup.current=release
  window.addEventListener('pointermove',move);window.addEventListener('pointerup',finish);window.addEventListener('pointercancel',finish)
 }
 const onKeyDown=(event:KeyboardEvent<HTMLDivElement>)=>{
  if(!canDrag(event.target))return
  const delta={ArrowLeft:[-8,0],ArrowRight:[8,0],ArrowUp:[0,-8],ArrowDown:[0,8]}[event.key]
  const box=ref.current?.getBoundingClientRect()
  if(delta&&box){event.preventDefault();setPosition(clamp({left:box.left+delta[0],top:box.top+delta[1]}))}
 }
 return {onPointerDown,onKeyDown,style:position?{'--camera-panel-left':`${position.left}px`,'--camera-panel-top':`${position.top}px`} as CSSProperties:undefined}
}
