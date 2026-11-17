import {installDomEnvironment} from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import {act,useRef} from 'react'
import {createRoot} from 'react-dom/client'
import {useCameraPanelDrag} from '../src/components/digital-person/useCameraPanelDrag'

test('camera panel drags by its header, ignores controls and stays inside the viewport',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 Object.defineProperties(window,{innerWidth:{value:1440,configurable:true},innerHeight:{value:900,configurable:true}})
 function Harness({enabled=true}:{enabled?:boolean}){
  const ref=useRef<HTMLDivElement>(null),drag=useCameraPanelDrag(ref,enabled)
  return <div ref={ref} data-panel style={drag.style} onPointerDown={drag.onPointerDown} onKeyDown={drag.onKeyDown}>
   <div className="video-preview-window--docked"><div className="video-preview-header" tabIndex={0}><span>摄像头</span><button>关闭</button></div></div>
  </div>
 }
 try{
  await act(async()=>root.render(<Harness/>))
  const panel=host.querySelector<HTMLElement>('[data-panel]')!,header=panel.querySelector('span')!
  panel.getBoundingClientRect=()=>({x:1000,y:300,left:1000,top:300,right:1320,bottom:550,width:320,height:250,toJSON:()=>({})})
  const pointer=(target:EventTarget,type:string,x:number,y:number)=>target.dispatchEvent(new window.PointerEvent(type,{bubbles:true,pointerId:1,button:0,clientX:x,clientY:y}))
  await act(async()=>{pointer(header,'pointerdown',1010,310);pointer(window,'pointermove',850,230);pointer(window,'pointerup',850,230)})
  assert.equal(panel.style.getPropertyValue('--camera-panel-left'),'840px')
  assert.equal(panel.style.getPropertyValue('--camera-panel-top'),'220px')
  const previous=panel.style.cssText
  await act(async()=>{pointer(panel.querySelector('button')!,'pointerdown',1010,310);pointer(window,'pointermove',1100,400);pointer(window,'pointerup',1100,400)})
  assert.equal(panel.style.cssText,previous,'buttons do not start a drag')
  await act(async()=>{pointer(header,'pointerdown',1010,310);pointer(window,'pointermove',9999,9999);pointer(window,'pointercancel',9999,9999)})
  assert.equal(panel.style.getPropertyValue('--camera-panel-left'),'1112px')
  assert.equal(panel.style.getPropertyValue('--camera-panel-top'),'642px')
  Object.defineProperty(window,'innerWidth',{value:1100,configurable:true})
  await act(async()=>window.dispatchEvent(new window.Event('resize')))
  assert.equal(panel.style.getPropertyValue('--camera-panel-left'),'772px')
  await act(async()=>root.render(<Harness enabled={false}/>))
  assert.equal(panel.style.getPropertyValue('--camera-panel-left'),'','closing resets placement')
 }finally{await act(async()=>root.unmount());await window.happyDOM.close()}
})
