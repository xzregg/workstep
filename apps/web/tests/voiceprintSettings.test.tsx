import { installDomEnvironment } from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import VoiceprintSettings from '../src/components/VoiceprintSettings'
import { voiceprintApi, type VoiceprintStatus } from '../src/api/voiceprint'
import { voiceCapture } from '../src/utils/voiceCapture'

const initial: VoiceprintStatus = {available:true,runtime_available:true,enrolled:false,enabled:false,scope:'calls',model_bytes:28281165,source:'https://example.com/model',install:{stage:'idle',downloaded_bytes:0,total_bytes:28281165,error:''}}

test('voiceprint enrollment, test, scope and deletion own their audio and saved state', async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const original={...voiceprintApi},capture=voiceCapture.start
 let callback!:Parameters<typeof voiceCapture.start>[0],stops=0,status={...initial},busy=false
 const submitted:number[]=[],saves:{enabled:boolean;scope:string}[]=[]
 voiceCapture.start=async next=>{callback=next;return {stop(){stops++},flush(){}}}
 voiceprintApi.enroll=async audio=>{submitted.push(atob(audio).length);status={...status,enrolled:true};return {...status}}
 voiceprintApi.test=async audio=>{submitted.push(atob(audio).length);return {speaker_status:'unmatched'}}
 voiceprintApi.configure=async(enabled,scope)=>{saves.push({enabled,scope});status={...status,enabled,scope};return {...status}}
 voiceprintApi.delete=async()=>{status={...initial};return {...status}}
 const button=(label:string)=>[...host.querySelectorAll('button')].find(b=>b.textContent===label)!
 try {
  await act(async()=>root.render(<I18nProvider><VoiceprintSettings initialStatus={initial} disabled={false} onBusyChange={value=>{busy=value}}/></I18nProvider>))
  assert.equal(host.querySelector<HTMLInputElement>('input')!.disabled,true)
  await act(async()=>button('录入声纹').click());assert.equal(busy,true)
  const prompt = host.querySelector('.voiceprint-prompt')!
  assert.deepEqual([...prompt.querySelectorAll('p')].map(p=>p.textContent), [
   '请自然朗读：',
   '今天我想整理一下接下来的工作安排。我会清楚地说出自己的想法，也会在句子之间稍作停顿。',
   '请累计朗读至少 6 秒。',
  ])
  assert.equal(prompt.querySelector('.voiceprint-prompt-text')?.textContent?.includes('请'), false)
  assert.equal(prompt.querySelectorAll('br').length, 0)
  assert.equal(button('完成并保存').disabled,true)
  await act(async()=>callback(new Int16Array(96000),.2,{lastVoice:96000,hasSpeech:true,recentSpeech:true,candidate:false,canCommit:false}))
  assert.equal(button('完成并保存').disabled,false)
  assert.equal(host.querySelector('.voiceprint-prompt') === prompt, true)
  assert.equal(prompt.querySelectorAll('p').length, 3)
  await act(async()=>button('完成并保存').click())
  assert.deepEqual(submitted,[192000]);assert.equal(busy,false);assert.match(host.textContent!,/声纹已保存/)
  await act(async()=>host.querySelector<HTMLInputElement>('input')!.click())
  assert.deepEqual(saves,[{enabled:true,scope:'calls'}])
  await act(async()=>{const select=host.querySelector('select')!;select.value='all';select.dispatchEvent(new window.Event('change',{bubbles:true}))})
  assert.equal(saves.at(-1)?.scope,'all')
  await act(async()=>button('测试声纹').click())
  assert.equal(host.querySelector('.voiceprint-prompt')?.textContent, '请说一句完整的话，测试是否能匹配你的声音。')
  assert.equal(host.querySelectorAll('.voiceprint-prompt-text').length, 0)
  await act(async()=>callback(new Int16Array(32000),.2,{lastVoice:32000,hasSpeech:true,recentSpeech:true,candidate:false,canCommit:false}))
  await act(async()=>button('完成并验证').click())
  assert.match(host.textContent!,/未匹配到你的声音/)
  await act(async()=>button('删除声纹').click())
  assert.ok(document.querySelector('[role=dialog]'))
  await act(async()=>document.querySelector<HTMLButtonElement>('.confirm-dialog-confirm')!.click())
  assert.match(host.textContent!,/尚未录入声纹/);assert.equal(host.querySelector<HTMLInputElement>('input')!.checked,false)
  assert.ok(stops>=2)
 } finally {await act(async()=>root.unmount());Object.assign(voiceprintApi,original);voiceCapture.start=capture;await window.happyDOM.close()}
})

test('cancelling permission or navigating away drops late capture and never saves enrollment',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const capture=voiceCapture.start,enroll=voiceprintApi.enroll
 let resolve!: (capture:Awaited<ReturnType<typeof voiceCapture.start>>)=>void,stops=0,saved=0
 voiceCapture.start=()=>new Promise(done=>{resolve=done})
 voiceprintApi.enroll=async()=>{saved++;return initial}
 try {
  await act(async()=>root.render(<I18nProvider><VoiceprintSettings initialStatus={initial} disabled={false}/></I18nProvider>))
  await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='录入声纹')!.click())
  await act(async()=>[...host.querySelectorAll('button')].find(b=>b.textContent==='取消录音')!.click())
  await act(async()=>resolve({stop(){stops++},flush(){}}))
  assert.equal(stops,1);assert.equal(saved,0)
  assert.match(host.textContent!,/尚未录入声纹/)
 }finally {await act(async()=>root.unmount());voiceCapture.start=capture;voiceprintApi.enroll=enroll;await window.happyDOM.close()}
})
