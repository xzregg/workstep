import { useEffect, useRef, useState } from 'react'
import type { ReactNode, PointerEvent } from 'react'

export function GatewayModal({ title, children, footer, onClose }: {
 title: string; children: ReactNode; footer: ReactNode; onClose: () => void
}) {
 const dialog = useRef<HTMLDialogElement>(null)
 const [size, setSize] = useState<{width:number;height:number} | null>(null)
 const drag = useRef<{x:number;y:number;width:number;height:number;edge:string} | null>(null)
 useEffect(() => {
  const node = dialog.current
  const focus = document.activeElement as HTMLElement | null
  if (node?.showModal) node.showModal()
  else node?.setAttribute('open','')
  return () => { node?.close?.(); focus?.focus() }
 }, [])
 function start(event: PointerEvent<HTMLSpanElement>, edge: string) {
  const bounds = dialog.current!.getBoundingClientRect()
  drag.current = { x:event.clientX, y:event.clientY, width:bounds.width, height:bounds.height, edge }
  event.currentTarget.setPointerCapture(event.pointerId)
  event.preventDefault()
 }
 function move(event: PointerEvent<HTMLSpanElement>) {
  const current = drag.current
  if (!current) return
  const dx = (event.clientX-current.x)*2, dy = (event.clientY-current.y)*2
  setSize({width:Math.min(window.innerWidth-32,Math.max(320,current.width+(current.edge.includes('e')?dx:current.edge.includes('w')?-dx:0))),
   height:Math.min(window.innerHeight-32,Math.max(320,current.height+(current.edge.includes('s')?dy:current.edge.includes('n')?-dy:0)))})
 }
 return <dialog ref={dialog} className="gateway-modal" aria-label={title} style={size ?? undefined}
  onCancel={event=>{event.preventDefault();onClose()}} onClick={event=>{if(event.target===event.currentTarget)onClose()}}>
  <header className="gateway-modal-header"><h3>{title}</h3><button type="button" aria-label="关闭弹窗" onClick={onClose}>×</button></header>
  <div className="gateway-modal-body">{children}</div>
  <footer className="gateway-modal-footer">{footer}</footer>
  {['n','s','e','w','ne','nw','se','sw'].map(edge=><span key={edge} aria-hidden="true" className={`gateway-modal-resize gateway-modal-resize-${edge}`}
   onPointerDown={event=>start(event,edge)} onPointerMove={move} onPointerUp={()=>{drag.current=null}} onLostPointerCapture={()=>{drag.current=null}} />)}
 </dialog>
}
