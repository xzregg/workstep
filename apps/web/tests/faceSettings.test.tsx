import {installDomEnvironment} from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {I18nProvider} from '../src/i18n'
import FaceEnrollment from '../src/components/face-recognition/FaceEnrollment'
import DigitalPersonCamera from '../src/components/digital-person/DigitalPersonCamera'
import {faceApi,FACE_MODEL_VERSION,type FaceCatalog} from '../src/api/faces'
import {faceRuntime} from '../src/components/face-recognition/runtime'
import {fsApi} from '../src/api/client'

const catalog:FaceCatalog={revision:1,model_version:FACE_MODEL_VERSION,settings:{enabled:true,show_names:true,include_people:true,include_relationship:true,preset:'balanced',threshold:.65},people:[]}

async function setup(){
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const original={...faceApi},oldDetect=faceRuntime.detect
 Object.assign(globalThis,{location:window.location,history:window.history})
 Object.defineProperty(document,'hidden',{configurable:true,value:false})
 faceApi.catalog=async()=>structuredClone(catalog);faceApi.revision=async()=>({revision:1})
 let stops=0
 const track={stop(){stops++},addEventListener(){},readyState:'live'}
 Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>({getTracks:()=>[track],getVideoTracks:()=>[track]})}})
 window.HTMLVideoElement.prototype.play=async()=>{}
 Object.defineProperty(window.HTMLVideoElement.prototype,'srcObject',{configurable:true,writable:true,value:null})
 window.HTMLCanvasElement.prototype.getContext=function(){const target=this;return {drawImage(source:any){(target as any).marker=source.marker}} as any}
 const click=async(text:string)=>act(async()=>{const button=[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===text);assert.ok(button,text);button.click()})
 const input=async(placeholder:string,value:string)=>act(async()=>{const el=host.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!;Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(el,value);el.dispatchEvent(new window.Event('input',{bubbles:true}))})
 const readyVideo=()=>{const video=host.querySelector('video')!;Object.defineProperties(video,{videoWidth:{value:640},videoHeight:{value:480},readyState:{value:2}});return video}
 return {window,host,root,click,input,readyVideo,stops:()=>stops,close:async()=>{await act(async()=>root.unmount());Object.assign(faceApi,original);faceRuntime.detect=oldDetect;await window.happyDOM.close()}}
}

test('three numbered captures gate enrollment; failed save preserves samples and successful retry commits once',async()=>{
 const ui=await setup();let attempts=0,saved=0
 faceRuntime.detect=async()=>[{box:[0,0,.5,.5],embedding:Array(1024).fill(.1),score:.99,person:null}]
 faceApi.create=async value=>{attempts++;assert.equal(value.embeddings.length,3);assert.equal(value.model_version,FACE_MODEL_VERSION);if(attempts===1)throw Error('保存失败');return {id:'p'} as any}
 try{
  await act(async()=>ui.root.render(<I18nProvider><FaceEnrollment onSaved={()=>saved++} onClose={()=>{}}/></I18nProvider>))
  assert.equal([...ui.host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='下一步')!.disabled,true)
  await ui.input('例如：小张','小张');await ui.input('例如：朋友、家人、同事','朋友');await act(async()=>ui.host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());await ui.click('下一步')
  assert.deepEqual([...ui.host.querySelectorAll('.face-samples-progress b')].map(e=>e.textContent),['1','2','3'])
  await ui.click('打开摄像头');ui.readyVideo()
  for(let i=1;i<=3;i++){await ui.click(`采集第 ${i} 张`);assert.equal(ui.stops(),0,'collecting must not stop camera')}
  await ui.click('下一步');assert.equal(ui.stops(),1,'review unmounts capture and releases stream')
  await ui.click('保存人物');assert.match(ui.host.textContent||'',/保存失败/);assert.equal(saved,0)
  await ui.click('保存人物');assert.equal(attempts,2);assert.equal(saved,1)
 }finally{await ui.close()}
})

test('send annotates the exact uploaded frame with canonical names; user text contains no face context',async()=>{
 const ui=await setup(),upload=fsApi.uploadImage;let prepare:((text:string)=>Promise<string>)|null=null,marker='old',sentIds:string[]=[],uploaded='',annotations:string[]=[],boxes=0
 faceRuntime.detect=async canvas=>[{box:[0,0,.5,.5],embedding:Array(1024).fill(.1),score:.99,person:{id:(canvas as any).marker||marker,name:'后台名字',relationship:'朋友',embeddings:[]}}]
 faceApi.context=async ids=>{sentIds=ids;return {people:ids.map(id=>({person_id:id,name:'当前称呼',relationship:'朋友'})),text:'不应加入用户正文的解释'}}
 ui.window.HTMLCanvasElement.prototype.getContext=function(){const target=this;return {drawImage(source:any){(target as any).marker=source.marker},save(){},restore(){},strokeRect(){boxes++},fillRect(){},measureText(value:string){return {width:value.length*10}},fillText(value:string){annotations.push(value)}} as any}
 ui.window.HTMLCanvasElement.prototype.toBlob=function(callback){callback(new Blob([(this as any).marker],{type:'image/jpeg'}))}
 fsApi.uploadImage=async file=>{uploaded=await file.text();return {url:'.workstep/uploads/frame.jpg',filename:file.name,size:file.size}}
 const callback=(fn:typeof prepare)=>{prepare=fn}
 try{
  await act(async()=>ui.root.render(<I18nProvider><DigitalPersonCamera projectId="demo" onPrepare={callback}/></I18nProvider>));await ui.click('打开摄像头');const video=ui.readyVideo() as any;video.marker='current';marker='current'
  let content='',faceIds:string[]=[];await act(async()=>{content=await (prepare as any)('看看',(ids:string[])=>{faceIds=ids})})
  assert.deepEqual(faceIds,['current'])
  assert.deepEqual(sentIds,['current']);assert.equal(uploaded,'current');assert.equal(boxes,1);assert.deepEqual(annotations,['当前称呼'])
  assert.match(content,/^看看\n\n!\[/);assert.match(content,/frame.jpg/);assert.doesNotMatch(content,/embedding|1024|后台名字|当前称呼|朋友|解释|people|person_id/)
 }finally{fsApi.uploadImage=upload;await ui.close()}
})

test('camera interruption releases a pending enrollment even when inference never settles',async()=>{
 const ui=await setup()
 faceRuntime.detect=()=>new Promise(()=>{})
 try{
  await act(async()=>ui.root.render(<I18nProvider><FaceEnrollment onSaved={()=>{}} onClose={()=>{}}/></I18nProvider>))
  await ui.input('例如：小张','小张');await ui.input('例如：朋友、家人、同事','朋友')
  await act(async()=>ui.host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());await ui.click('下一步')
  await ui.click('打开摄像头');ui.readyVideo();await ui.click('采集第 1 张')
  assert.ok(ui.host.querySelector('button.btn-loading'))
  await ui.click('关闭摄像头')
  assert.equal(ui.host.querySelector('button.btn-loading'),null,'camera stop must release the pending capture')
  assert.match(ui.host.textContent||'',/摄像头已关闭/)
  assert.equal(ui.host.querySelector<HTMLButtonElement>('.face-panel-header button')!.disabled,false)
 }finally{await ui.close()}
})
