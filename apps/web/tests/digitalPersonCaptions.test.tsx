import {installDomEnvironment} from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {I18nProvider} from '../src/i18n'
import DigitalPersonCaptions from '../src/components/digital-person/DigitalPersonCaptions'
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

test('caption history renders project images and assistant Markdown without dropping attachments',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 try{
  await act(async()=>root.render(<I18nProvider><DigitalPersonCaptions projectId="p" sessionId="main" greeting="你好" liveText="" messages={[
   {id:'u',role:'user',content:'看这张图\n\n![相机照片](.workstep/uploads/camera.jpg)'},
   {id:'a',role:'assistant',content:'**分析结果**\n\n![结果图](.workstep/uploads/result.png)',status:'succeeded'},
  ]}/></I18nProvider>))
  const images=host.querySelectorAll('img')
  assert.equal(images.length,2)
  assert.equal(images[0].getAttribute('src'),resolveMarkdownImageSrc('.workstep/uploads/camera.jpg','p'))
  assert.equal(images[1].getAttribute('src'),resolveMarkdownImageSrc('.workstep/uploads/result.png','p'))
  assert.equal(host.querySelector('.digital-home-reply strong')?.textContent,'分析结果')
  await act(async()=>images[0].click())
  assert.ok(document.querySelector('.image-preview'),'image opens shared preview outside the fading scroll area')
 }finally{await act(async()=>root.unmount());await window.happyDOM.close()}
})
