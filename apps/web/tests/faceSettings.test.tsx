import {installDomEnvironment} from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {I18nProvider,useLocaleStore} from '../src/i18n'
import FaceEnrollment from '../src/components/face-recognition/FaceEnrollment'
import FaceSettingsPanel from '../src/components/face-recognition/FaceSettingsPanel'
import DigitalPersonCamera from '../src/components/digital-person/DigitalPersonCamera'
import {faceApi,FACE_MODEL_VERSION,type FaceCatalog} from '../src/api/faces'
import {FACE_CHANGED,faceRuntime} from '../src/components/face-recognition/runtime'
import {fsApi} from '../src/api/client'

const catalog:FaceCatalog={revision:1,model_version:FACE_MODEL_VERSION,settings:{enabled:true,show_names:true,include_people:true,include_relationship:true,preset:'balanced',threshold:.65},people:[]}

async function setup(){
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const original={...faceApi},oldDetect=faceRuntime.detect
 Object.assign(globalThis,{location:window.location,history:window.history})
 useLocaleStore.setState({locale:'zh-CN',language:null})
 Object.defineProperty(document,'hidden',{configurable:true,value:false})
 faceApi.catalog=async()=>structuredClone(catalog);faceApi.revision=async()=>({revision:1})
 let stops=0,lighting=125,texture=30
 const track={stop(){stops++},addEventListener(){},readyState:'live'}
 Object.defineProperty(navigator,'mediaDevices',{configurable:true,value:{getUserMedia:async()=>({getTracks:()=>[track],getVideoTracks:()=>[track]})}})
 window.HTMLVideoElement.prototype.play=async()=>{}
 Object.defineProperty(window.HTMLVideoElement.prototype,'srcObject',{configurable:true,writable:true,value:null})
 window.HTMLCanvasElement.prototype.getContext=function(){const target=this;return {
  drawImage(source:any){(target as any).marker=source.marker},
  getImageData(_left:number,_top:number,width:number,height:number){return {data:Uint8ClampedArray.from({length:width*height*4},(_,index)=>index%4===3?255:lighting+(Math.floor(index/4)%2-.5)*texture)}},
 } as any}
 const click=async(text:string)=>act(async()=>{const button=[...host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===text);assert.ok(button,text);button.click()})
 const input=async(placeholder:string,value:string)=>act(async()=>{const el=host.querySelector<HTMLInputElement>(`input[placeholder="${placeholder}"]`)!;Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(el,value);el.dispatchEvent(new window.Event('input',{bubbles:true}))})
 const readyVideo=()=>{const video=host.querySelector('video')!;Object.defineProperties(video,{videoWidth:{value:640},videoHeight:{value:480},readyState:{value:2},currentTime:{configurable:true,get:()=>performance.now()/1000}});return video}
 return {window,host,root,click,input,readyVideo,stops:()=>stops,setQuality:(level:number,detail:number)=>{lighting=level;texture=detail},close:async()=>{await act(async()=>root.unmount());Object.assign(faceApi,original);faceRuntime.detect=oldDetect;await window.happyDOM.close()}}
}

test('face box visibility defaults on and saves independently of names',async()=>{
 const ui=await setup()
 let saved:typeof catalog.settings|undefined
 faceApi.people=async()=>({items:[]})
 faceApi.settings=async()=>({settings:saved??catalog.settings,revision:1})
 faceApi.saveSettings=async settings=>{saved=settings;return {settings,revision:2}}
 try{
  await act(async()=>ui.root.render(<I18nProvider><FaceSettingsPanel/></I18nProvider>))
  await ui.click('识别设置')
  const checkbox=()=>[...ui.host.querySelectorAll('label')].find(label=>label.textContent==='显示人脸框')?.querySelector('input')
  assert.equal(checkbox()?.checked,true)
  await act(async()=>checkbox()!.click())
  assert.equal(checkbox()?.checked,false)
  assert.equal(saved,undefined)
  await ui.click('保存')
  assert.equal(saved?.show_boxes,false)
  assert.equal(saved?.show_names,true)
 }finally{await ui.close()}
})

test('five stable poses auto-capture in one stream; preview supports single retake and save retry',async()=>{
 const ui=await setup();let attempts=0,saved=0
 let pose={yaw:0,pitch:0,roll:0},embedding=.1,faceBox=[.2,.2,.45,.5],faceCount=1
 faceRuntime.detect=async(_canvas,_catalog,_width,poseOnly)=>{
  if(poseOnly&&pose.yaw===-14)await new Promise(resolve=>setTimeout(resolve,700))
  return Array.from({length:faceCount},()=>({box:[0,0,1,1],faceBox,embedding:poseOnly?[]:Array(1024).fill(embedding),score:.99,person:null,pose}))
 }
 const waitFor=async(selector:string,text:string)=>{
  const end=Date.now()+3500
  while(ui.host.querySelector(selector)?.textContent!==text&&Date.now()<end)await act(async()=>{await new Promise(resolve=>setTimeout(resolve,35))})
  assert.equal(ui.host.querySelector(selector)?.textContent,text)
 }
 faceApi.create=async value=>{attempts++;assert.deepEqual(value.embeddings.map(sample=>sample[0]),[.1,.2,.3,.4,.9]);assert.equal(value.model_version,FACE_MODEL_VERSION);assert.equal('canvas' in value,false);if(attempts===1)throw Error('保存失败');return {id:'p'} as any}
 try{
  await act(async()=>ui.root.render(<I18nProvider><FaceEnrollment onSaved={()=>saved++} onClose={()=>{}}/></I18nProvider>))
  assert.equal([...ui.host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='下一步')!.disabled,true)
  await ui.input('例如：小张','小张');await ui.input('例如：朋友、家人、同事','朋友');await act(async()=>ui.host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());await ui.click('下一步')
  ui.setQuality(20,30)
  ui.readyVideo()
  await waitFor('.face-enrollment-cue','请调整光线，避免过暗或直射')
  const box=()=>ui.host.querySelector<HTMLElement>('.face-box--enrollment')
  assert.equal(box()?.style.left,'20%')
  faceCount=2
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,260))})
  assert.equal(box(),null)
  faceCount=1
  faceBox=[-.05,.2,.45,.5]
  await waitFor('.face-enrollment-cue','请把脸移到画面中央')
  faceBox=[.3,.2,.45,.5]
  ui.setQuality(125,0)
  await waitFor('.face-enrollment-cue','请保持不动，让画面更清晰')
  assert.equal(box()?.style.left,'30%')
  assert.equal(ui.host.querySelector('.face-enrollment-pose')?.textContent,'正面')
  ui.setQuality(125,30)
  await waitFor('.face-enrollment-progress','')
  assert.ok(box()?.classList.contains('face-box--holding'))
  await waitFor('.face-enrollment-pose','稍向左转')
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,850))})
  assert.equal(ui.host.querySelector('.face-enrollment-pose')?.textContent,'稍向左转','another frontal view does not count as left')
  assert.equal(ui.host.querySelectorAll('.face-enrollment-pose').length,1)
  assert.equal(ui.stops(),0)
  pose={yaw:14,pitch:0,roll:0}
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,850))})
  assert.equal(ui.host.querySelector('.face-enrollment-pose')?.textContent,'稍向左转','opposite turn does not count')
  for(const [yaw,pitch,value,next] of [[-14,0,.2,'稍向右转'],[14,0,.3,'稍微抬头'],[0,-14,.4,'稍微低头']] as const){
   pose={yaw,pitch,roll:0};embedding=value;await waitFor('.face-enrollment-pose',next);assert.equal(ui.stops(),0)
  }
  pose={yaw:0,pitch:20,roll:0};embedding=.5
  await waitFor('.face-enrollment-index','5 / 5');assert.equal(ui.stops(),1)
  assert.equal(box(),null)
  await ui.click('下一张');await waitFor('.face-enrollment-index','1 / 5')
  await ui.click('上一张');await ui.click('重录此张');ui.readyVideo();embedding=.9
  await waitFor('.face-enrollment-index','5 / 5');assert.equal(ui.stops(),2)
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
  faceApi.catalog=async()=>({...catalog,revision:2,settings:{...catalog.settings,show_boxes:false}})
  await act(async()=>window.dispatchEvent(new window.Event(FACE_CHANGED)))
  await act(async()=>{await (prepare as any)('再看看',(ids:string[])=>{faceIds=ids})})
  assert.equal(boxes,1,'second photo draws no border')
  assert.deepEqual(annotations,['当前称呼','当前称呼'])
  assert.deepEqual(faceIds,['current'])
  const deadline=performance.now()+1200
  while(!ui.host.querySelector('.face-box--no-outline.face-box--known')&&performance.now()<deadline){
   await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30))})
  }
  assert.equal(ui.host.querySelector('.face-box--no-outline.face-box--known')?.textContent,'后台名字')
 }finally{fsApi.uploadImage=upload;await ui.close()}
})

test('camera send reuses only a recent preview match without annotating the new picture',async()=>{
 const ui=await setup(),upload=fsApi.uploadImage
 let prepare:import('../src/components/digital-person/DigitalPersonCamera').PrepareCameraMessage|null=null,uploaded='',boxes=0
 faceRuntime.detect=async canvas=>{
  const id=(canvas as any).marker
  return id==='known'||id==='current'?[{box:[0,0,.5,.5],embedding:[],score:.99,person:{id,name:'熟人',relationship:'朋友',embeddings:[]}}]:[]
 }
 faceApi.context=async ids=>({people:ids.map(id=>({person_id:id,name:'熟人'})),text:''})
 ui.window.HTMLCanvasElement.prototype.getContext=function(){const target=this;return {drawImage(source:any){(target as any).marker=source.marker},save(){},restore(){},strokeRect(){boxes++},fillRect(){},measureText(){return {width:10}},fillText(){}} as any}
 ui.window.HTMLCanvasElement.prototype.toBlob=function(callback){callback(new Blob([(this as any).marker]))}
 fsApi.uploadImage=async file=>{uploaded=await file.text();return {url:'.workstep/uploads/frame.jpg',filename:file.name,size:file.size}}
 const send=async()=>{let observation:unknown;await act(async()=>{await prepare!('看看',(ids,recent)=>{observation=[ids,Boolean(recent)]})});return observation}
 try{
  await act(async()=>ui.root.render(<I18nProvider><DigitalPersonCamera projectId="demo" onPrepare={fn=>{prepare=fn}}/></I18nProvider>));await ui.click('打开摄像头')
  const video=ui.readyVideo() as any;video.marker='known'
  const deadline=Date.now()+2000
  while(!ui.host.querySelector('.face-box--known')&&Date.now()<deadline)await act(async()=>{await new Promise(resolve=>setTimeout(resolve,30))})
  assert.ok(ui.host.querySelector('.face-box--known'))
  video.marker='blurred'
  assert.deepEqual(await send(),[['known'],true]);assert.equal(uploaded,'blurred');assert.equal(boxes,0)
  video.marker='current'
  assert.deepEqual(await send(),[['current'],false]);assert.equal(uploaded,'current');assert.equal(boxes,1)
  video.marker='blurred'
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,1050))})
  assert.deepEqual(await send(),[[],false])
 }finally{fsApi.uploadImage=upload;await ui.close()}
})

test('preview requires fresh frames, expires on a frozen stream and clears on library change',async()=>{
 const ui=await setup()
 let mediaTime=1,calls=0,revision=1
 faceApi.catalog=async()=>({...structuredClone(catalog),revision})
 faceRuntime.detect=async()=>{
  calls++
  return [{box:[.2,.2,.4,.4],embedding:[.1],score:.99,person:{id:'known',name:'熟人',relationship:'',embeddings:[]}}]
 }
 const known=()=>ui.host.querySelector('.face-box--known')
 const wait=async(ms:number)=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,ms))})
 const until=async(condition:()=>boolean)=>{
  const deadline=performance.now()+2000
  while(!condition()&&performance.now()<deadline)await wait(25)
  assert.ok(condition())
 }
 try{
  await act(async()=>ui.root.render(<I18nProvider><DigitalPersonCamera projectId="demo"/></I18nProvider>))
  await ui.click('打开摄像头')
  Object.defineProperty(ui.readyVideo(),'currentTime',{get:()=>mediaTime})
  await until(()=>calls===1)
  await wait(220)
  assert.equal(calls,1)
  assert.equal(known(),null)
  mediaTime++
  await until(()=>Boolean(known()))
  await until(()=>!known())
  assert.equal(calls,2)
  for(let i=0;i<2;i++){mediaTime++;await until(()=>calls===3+i)}
  assert.ok(known())
  await act(async()=>{revision++;window.dispatchEvent(new window.Event(FACE_CHANGED))})
  assert.equal(known(),null)
 }finally{await ui.close()}
})

test('camera interruption releases a pending enrollment even when inference never settles',async()=>{
 const ui=await setup()
 faceRuntime.detect=()=>new Promise(()=>{})
 try{
  await act(async()=>ui.root.render(<I18nProvider><FaceEnrollment onSaved={()=>{}} onClose={()=>{}}/></I18nProvider>))
  await ui.input('例如：小张','小张');await ui.input('例如：朋友、家人、同事','朋友')
  await act(async()=>ui.host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());await ui.click('下一步')
  ui.readyVideo()
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,250))})
  await ui.click('关闭摄像头')
  assert.equal(ui.stops(),1)
  assert.match(ui.host.textContent||'',/请打开摄像头/)
  assert.equal(ui.host.querySelector<HTMLButtonElement>('.face-panel-header button')!.disabled,false)
 }finally{await ui.close()}
})
