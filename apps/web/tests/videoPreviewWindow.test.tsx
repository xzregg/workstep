import {installDomEnvironment} from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import {act,createRef} from 'react'
import {createRoot} from 'react-dom/client'
import {I18nProvider} from '../src/i18n'
import VideoPreviewWindow from '../src/components/VideoPreviewWindow'

test('shared video window fits portrait and landscape frames, anchors to eyes and preserves dragged placement',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host),video=createRef<HTMLVideoElement>()
 Object.defineProperties(window,{innerWidth:{value:390,configurable:true},innerHeight:{value:844,configurable:true}})
 try{
  await act(async()=>root.render(<I18nProvider><VideoPreviewWindow open videoRef={video} label="视频预览" onClose={()=>{}} getAnchor={()=>({x:210,y:350})}/></I18nProvider>))
  const panel=host.querySelector<HTMLElement>('.video-preview-window')!
  const bounds=()=>({left:parseFloat(panel.style.left),top:parseFloat(panel.style.top),width:parseFloat(panel.style.width),height:parseFloat(panel.style.height)})
  let b=bounds()
  assert.ok(b.width>192,'default preview is larger')
  assert.equal(panel.getAttribute('data-video-ready'),'false','no assumed video ratio before camera metadata')
  assert.ok(Math.abs(b.left+b.width/2-210)<1)
  assert.ok(Math.abs(b.top+b.height/2-350)<1,'video centered over eyes')
  Object.defineProperties(video.current!,{videoWidth:{configurable:true,value:720},videoHeight:{configurable:true,value:1280}})
  await act(async()=>video.current!.dispatchEvent(new window.Event('loadedmetadata')))
  b=bounds();assert.ok(Math.abs((b.width-1)/(b.height-1)-9/16)<.001)
  const pointer=(target:EventTarget,type:string,x:number,y:number)=>target.dispatchEvent(new window.PointerEvent(type,{bubbles:true,pointerId:1,button:0,clientX:x,clientY:y}))
  await act(async()=>{pointer(video.current!,'pointerdown',100,100);pointer(window,'pointermove',60,150);pointer(window,'pointerup',60,150)})
  assert.ok(Math.abs(bounds().left-(b.left-40))<1,'dragging video moves entire window')
  const dragged=bounds()
  Object.defineProperties(video.current!,{videoWidth:{configurable:true,value:1280},videoHeight:{configurable:true,value:720}})
  await act(async()=>video.current!.dispatchEvent(new window.Event('resize')))
  b=bounds();assert.ok(Math.abs((b.width-1)/(b.height-1)-16/9)<.001)
  assert.ok(Math.abs(b.left+b.width/2-(dragged.left+dragged.width/2))<1,'metadata does not snap dragged window back to eyes')
  Object.defineProperties(window,{innerWidth:{value:844,configurable:true},innerHeight:{value:390,configurable:true}})
  await act(async()=>{window.dispatchEvent(new window.Event('resize'));await new Promise(resolve=>setTimeout(resolve,20))})
  b=bounds();assert.ok(b.left>=8&&b.top>=8&&b.left+b.width<=836&&b.top+b.height<=382)
 }finally{await act(async()=>root.unmount());await window.happyDOM.close()}
})
