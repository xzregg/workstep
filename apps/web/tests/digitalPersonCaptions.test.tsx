import {installDomEnvironment} from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {I18nProvider} from '../src/i18n'
import DigitalPersonCaptions from '../src/components/digital-person/DigitalPersonCaptions'
import {digitalRuntimeApi} from '../src/api/digitalPerson'
import {resolveMarkdownImageSrc} from '../src/utils/markdownImages'

test('captions retain earlier turns and follow new text only while reading the latest turn',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const messages=[{id:'u',role:'user' as const,content:'之前的问题'},{id:'a',role:'assistant' as const,content:'完整回复。'.repeat(80),status:'running' as const}]
 const render=async(content:string)=>act(async()=>root.render(<I18nProvider><DigitalPersonCaptions projectId="p" sessionId="main" messages={[messages[0],{...messages[1],content}]} greeting="你好" liveText=""/></I18nProvider>))
 try{
  await render(messages[1].content)
  const history=host.querySelector<HTMLElement>('.digital-home-subtitles')!
  Object.defineProperties(history,{scrollHeight:{value:1200,configurable:true},clientHeight:{value:300,configurable:true}})
  await render(messages[1].content+'下一句。')
  assert.equal(history.scrollTop,1200)
  assert.match(history.textContent!,/之前的问题/)
  assert.ok(history.textContent!.includes(messages[1].content))
  history.scrollTop=100
  await act(async()=>history.dispatchEvent(new window.Event('scroll')))
  await render(messages[1].content+'新内容。')
  assert.equal(history.scrollTop,100,'reading history must not jump to new text')
  history.scrollTop=900
  await act(async()=>history.dispatchEvent(new window.Event('scroll')))
  await render(messages[1].content+'继续。')
  assert.equal(history.scrollTop,1200)
 }finally{await act(async()=>root.unmount());await window.happyDOM.close()}
})

test('captions hide camera processing details while preserving ordinary images and assistant Markdown',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 try{
  await act(async()=>root.render(<I18nProvider><DigitalPersonCaptions projectId="p" sessionId="main" greeting="你好" liveText="" messages={[
   {id:'u',role:'user',content:'看到我是谁吗\n\n[本轮附图的人脸识别观察（可能有误）]\n{"people":[{"person_id":"p1","name":"小谢","relationship":"主人"}],"unknown_face_count":0}\n这些是画面中的人物，不代表谁正在发言；不改变消息作者或权限。\n\n![camera-123.jpg](.workstep/uploads/digital-person-camera-123.jpg)'},
   {id:'photo',role:'user',content:'看这张图\n\n![照片](.workstep/uploads/photo.jpg)'},
   {id:'a',role:'assistant',content:'**分析结果**\n\n![结果图](.workstep/uploads/result.png)',status:'succeeded'},
  ]}/></I18nProvider>))
  const images=host.querySelectorAll('img')
  assert.equal(images.length,2)
  assert.match(host.querySelector('.digital-home-user-caption')!.textContent!,/看到我是谁吗/)
  assert.doesNotMatch(host.textContent!,/person_id|小谢|人脸识别观察|unknown_face_count|不改变消息作者/)
  assert.equal(images[0].getAttribute('src'),resolveMarkdownImageSrc('.workstep/uploads/photo.jpg','p'))
  assert.equal(images[1].getAttribute('src'),resolveMarkdownImageSrc('.workstep/uploads/result.png','p'))
  assert.equal(host.querySelector('.digital-home-reply strong')?.textContent,'分析结果')
  await act(async()=>images[0].click())
  assert.ok(document.querySelector('.image-preview'),'image opens shared preview outside the fading scroll area')
 }finally{await act(async()=>root.unmount());await window.happyDOM.close()}
})

test('avatar transcript feedback restores historical votes and submits the original assistant message ID',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const original=digitalRuntimeApi.feedback,calls:Array<[string,number]>=[]
 digitalRuntimeApi.feedback=async(id,value)=>{calls.push([id,value]);return {} as any}
 const messages=[{id:'user',role:'user',content:'问题',status:'succeeded'},{id:'old-answer',role:'assistant',content:'历史回复',status:'succeeded'},{id:'running',role:'assistant',content:'正在生成',status:'running'},{id:'empty',role:'assistant',content:'',status:'succeeded'}] as any
 try{
  await act(async()=>root.render(<I18nProvider><DigitalPersonCaptions projectId="p" sessionId="main" messages={messages} feedback={{'old-answer':1}} greeting="你好" liveText=""/></I18nProvider>))
  assert.equal(host.querySelectorAll('.digital-person-feedback').length,1,'only completed nonempty assistant replies offer feedback')
  const [up,down]=host.querySelectorAll<HTMLButtonElement>('.digital-person-feedback button')
  assert.equal(up.getAttribute('aria-pressed'),'true')
  assert.ok(up.closest('.chat-message-row'),'uses shared desktop hover/mobile visibility')
  await act(async()=>down.click())
  assert.deepEqual(calls,[['old-answer',-1]])
  assert.equal(up.getAttribute('aria-pressed'),'false');assert.equal(down.getAttribute('aria-pressed'),'true')
  await act(async()=>down.click())
  assert.deepEqual(calls.at(-1),['old-answer',0])
 }finally{digitalRuntimeApi.feedback=original;await act(async()=>root.unmount());await window.happyDOM.close()}
})
