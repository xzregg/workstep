import {installDomEnvironment} from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {I18nProvider} from '../src/i18n'
import VideoPreviewWindow from '../src/components/VideoPreviewWindow'

for(const placement of ['avatar','top-right'] as const) test(`camera preview moves, resizes, clamps and closes (${placement})`,async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 Object.defineProperties(window,{innerWidth:{value:390,configurable:true},innerHeight:{value:844,configurable:true}})
 let closed=0
 try{
  await act(async()=>root.render(<I18nProvider><VideoPreviewWindow open getAnchor={placement==='avatar'?()=>({x:220,y:350}):undefined} label="视频预览" onClose={()=>closed++}/></I18nProvider>))
  const panel=host.querySelector<HTMLElement>('.video-preview-window')!
  const video=host.querySelector('video')!
  Object.defineProperties(video,{videoWidth:{value:720},videoHeight:{value:1280}})
  await act(async()=>video.dispatchEvent(new window.Event('loadedmetadata')))
  const header=host.querySelector<HTMLElement>('[data-video-drag]')!
  const pointer=(target:EventTarget,type:string,x:number,y:number)=>target.dispatchEvent(new window.PointerEvent(type,{bubbles:true,pointerId:1,button:0,clientX:x,clientY:y}))
  if(placement==='top-right'){assert.equal(parseFloat(panel.style.top),16,'no space above the video is reserved for controls');assert.equal(parseFloat(panel.style.left)+parseFloat(panel.style.width),374)}
  const left=parseFloat(panel.style.left)
  await act(async()=>{pointer(header,'pointerdown',100,100);pointer(window,'pointermove',60,130);pointer(window,'pointerup',60,130)})
  assert.equal(parseFloat(panel.style.left),left-40)
  const width=parseFloat(panel.style.width)
  await act(async()=>{pointer(host.querySelector('[data-video-resize="se"]')!,'pointerdown',100,100);pointer(window,'pointermove',120,120);pointer(window,'pointerup',120,120)})
  assert.equal(parseFloat(panel.style.width),width+20)
  const beforeVertical=parseFloat(panel.style.width)
  await act(async()=>{pointer(host.querySelector('[data-video-resize="se"]')!,'pointerdown',100,100);pointer(window,'pointermove',100,140);pointer(window,'pointerup',100,140)})
  assert.ok(parseFloat(panel.style.width)>beforeVertical,'vertical corner drag resizes proportionally too')
  await act(async()=>{pointer(header,'pointerdown',100,100);pointer(window,'pointermove',999,999);pointer(window,'pointercancel',999,999)})
  assert.ok(parseFloat(panel.style.left)+parseFloat(panel.style.width)<=382)
  assert.ok(parseFloat(panel.style.top)+parseFloat(panel.style.height)<=836)
  Object.defineProperty(window,'innerWidth',{value:320,configurable:true})
  await act(async()=>{window.dispatchEvent(new window.Event('resize'));await new Promise(resolve=>setTimeout(resolve,20))})
  assert.ok(parseFloat(panel.style.left)+parseFloat(panel.style.width)<=312.01, JSON.stringify({style:panel.style.cssText,inner:window.innerWidth,visual:window.visualViewport?.width}))
  await act(async()=>host.querySelector<HTMLButtonElement>('[data-video-close]')!.click())
  assert.equal(closed,1)
 }finally{await act(async()=>root.unmount());await window.happyDOM.close()}
})

test('double click and double tap zoom around the selected point without resizing the window',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 Object.defineProperties(window,{innerWidth:{value:390,configurable:true},innerHeight:{value:844,configurable:true}})
 try{
  await act(async()=>root.render(<I18nProvider><VideoPreviewWindow open label="预览" onClose={()=>{}}/></I18nProvider>))
  const panel=host.querySelector<HTMLElement>('.video-preview-window')!,video=host.querySelector('video')!,surface=host.querySelector<HTMLElement>('[data-video-drag]')!
  Object.defineProperties(video,{videoWidth:{value:720},videoHeight:{value:1280}})
  await act(async()=>video.dispatchEvent(new window.Event('loadedmetadata')))
  surface.getBoundingClientRect=()=>new window.DOMRect(100,100,200,400) as DOMRect
  const before=panel.style.cssText
  const click=()=>surface.dispatchEvent(new window.MouseEvent('dblclick',{bubbles:true,clientX:150,clientY:400}))
  const picture=()=>host.querySelector<HTMLElement>('.video-preview-picture')
  await act(async()=>click())
  assert.equal(surface.getAttribute('aria-pressed'),'true')
  assert.equal(picture()?.style.transformOrigin,'25% 75%')
  assert.equal(panel.style.cssText,before)
  await act(async()=>click())
  assert.equal(surface.getAttribute('aria-pressed'),'false')
  assert.equal(picture()?.style.transformOrigin,'')
  const touch=(type:string,x=250,y=200)=>surface.dispatchEvent(new window.PointerEvent(type,{bubbles:true,button:0,pointerId:7,pointerType:'touch',clientX:x,clientY:y}))
  const doubleTap=()=>{touch('pointerdown');touch('pointerup');touch('pointerdown');touch('pointerup')}
  await act(async()=>{doubleTap();click()})
  assert.equal(surface.getAttribute('aria-pressed'),'true','the native double click after a touch double tap is ignored')
  assert.equal(picture()?.style.transformOrigin,'75% 25%')
  assert.equal(panel.style.cssText,before)
  await act(async()=>doubleTap())
  assert.equal(surface.getAttribute('aria-pressed'),'false')
  await act(async()=>{touch('pointerdown');touch('pointermove',270);touch('pointerup',270);touch('pointerdown');touch('pointerup')})
  assert.equal(surface.getAttribute('aria-pressed'),'false','a drag followed by a tap does not zoom')
 }finally{await act(async()=>root.unmount());await window.happyDOM.close()}
})
