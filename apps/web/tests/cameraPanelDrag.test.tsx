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

test('desktop camera resizes proportionally with pointer and keyboard, fits metadata and viewport changes, and leaves mobile alone',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 Object.defineProperties(window,{innerWidth:{value:1440,configurable:true},innerHeight:{value:900,configurable:true}})
 function Harness(){
  const ref=useRef<HTMLDivElement>(null),drag=useCameraPanelDrag(ref,true)
  return <div ref={ref} data-panel style={drag.style} onPointerDown={drag.onPointerDown} onKeyDown={drag.onKeyDown}>
   <div className="video-preview-surface"><video/></div>
   {['n','e','s','w','ne','nw','se','sw'].map(edge=><div key={edge} data-camera-resize={edge} tabIndex={0}/>)}
  </div>
 }
 try{
  await act(async()=>root.render(<Harness/>))
  const panel=host.querySelector<HTMLElement>('[data-panel]')!,video=panel.querySelector('video')!,surface=panel.querySelector<HTMLElement>('.video-preview-surface')!
  const rect=(left:number,top:number,width:number,height:number)=>({x:left,y:top,left,top,width,height,right:left+width,bottom:top+height,toJSON:()=>({})})
  const width=()=>parseFloat(panel.style.getPropertyValue('--camera-panel-width'))||400
  const left=()=>parseFloat(panel.style.getPropertyValue('--camera-panel-left'))||600
  const top=()=>parseFloat(panel.style.getPropertyValue('--camera-panel-top'))||200
  panel.getBoundingClientRect=()=>rect(left(),top(),width(),Math.min((width()-18)/(video.videoWidth/video.videoHeight)+50,window.innerHeight-top()-8))
  surface.getBoundingClientRect=()=>rect(left()+9,top()+41,width()-18,(width()-18)/(video.videoWidth/video.videoHeight))
  Object.defineProperties(video,{videoWidth:{value:1280,configurable:true},videoHeight:{value:720,configurable:true}})
  const pointer=(target:EventTarget,type:string,x:number,y:number)=>target.dispatchEvent(new window.PointerEvent(type,{bubbles:true,pointerId:7,button:0,pointerType:'touch',clientX:x,clientY:y}))
  const resize=panel.querySelector<HTMLElement>('[data-camera-resize="se"]')!
  await act(async()=>{pointer(resize,'pointerdown',1000,465);pointer(window,'pointermove',1120,465);pointer(window,'pointerup',1120,465)})
  assert.equal(width(),520,'PC touch drag changes width')
  assert.equal(left(),600,'east edge keeps left anchor')
  await act(async()=>resize.dispatchEvent(new window.KeyboardEvent('keydown',{bubbles:true,key:'ArrowRight',shiftKey:true})))
  assert.equal(width(),552,'Shift accelerates keyboard resize')
  const west=panel.querySelector<HTMLElement>('[data-camera-resize="w"]')!,right=left()+width()
  await act(async()=>west.dispatchEvent(new window.KeyboardEvent('keydown',{bubbles:true,key:'ArrowLeft'})))
  assert.equal(width(),560);assert.equal(left()+width(),right,'west edge keeps right anchor')
  await act(async()=>{pointer(resize,'pointerdown',1000,465);pointer(window,'pointermove',9999,9999);pointer(window,'pointerup',9999,9999)})
  assert.ok(width()<=800);assert.ok(left()+width()<=1432)
  Object.defineProperty(video,'videoWidth',{value:720,configurable:true});Object.defineProperty(video,'videoHeight',{value:1280,configurable:true})
  await act(async()=>video.dispatchEvent(new window.Event('resize')))
  let box=panel.getBoundingClientRect()
  assert.ok(box.bottom<=892,'portrait camera switch stays in viewport')
  Object.defineProperty(window,'innerHeight',{value:360,configurable:true})
  await act(async()=>window.dispatchEvent(new window.Event('resize')))
  box=panel.getBoundingClientRect();assert.ok(box.top>=8&&box.bottom<=352,'short window overrides minimum size')
  assert.ok(width()<184,'compressed outer height must not hide overflowing portrait video')
  Object.defineProperty(window,'innerWidth',{value:390,configurable:true})
  await act(async()=>window.dispatchEvent(new window.Event('resize')))
  assert.equal(panel.style.getPropertyValue('--camera-panel-width'),'','mobile clears desktop geometry')
  await act(async()=>{pointer(resize,'pointerdown',100,100);pointer(window,'pointermove',200,200);pointer(window,'pointerup',200,200)})
  assert.equal(panel.style.getPropertyValue('--camera-panel-width'),'','mobile ignores desktop gestures')
 }finally{await act(async()=>root.unmount());await window.happyDOM.close()}
})
