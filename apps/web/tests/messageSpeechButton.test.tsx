import test from 'node:test'
import assert from 'node:assert/strict'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import { I18nProvider } from '../src/i18n'
import MessageResponseFooter from '../src/components/MessageResponseFooter'
import { OUTPUT_CHANGED, speechOutputApi } from '../src/api/speechOutput'
import { outputStatus } from './fixtures/speechOutput'

test('all completed replies expose shared speech actions, deduplicate settings and switch playback', async () => {
  const {window}=installDomEnvironment()
  const host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
  const original=speechOutputApi.status
  let reads=0
  const sent: {type:string;id:string;text?:string}[]=[]
  ;(window as any).WorkStepSpeech={postMessage:(raw:string)=>sent.push(JSON.parse(raw)),onmessage:null}
  speechOutputApi.status=async()=>{reads++;return structuredClone(outputStatus)}
  try{
    await act(async()=>root.render(<I18nProvider>
      <MessageResponseFooter projectId="speech-test" content="历史回复。" />
      <MessageResponseFooter projectId="speech-test" content="最新回复。" />
      <MessageResponseFooter projectId="speech-test" content="运行中" running />
    </I18nProvider>))
    const buttons=host.querySelectorAll<HTMLButtonElement>('button[aria-label="朗读回复"]')
    assert.equal(buttons.length,2)
    assert.equal(reads,1)
    assert.ok(buttons[0].closest('.message-response-footer'))
    await act(async()=>buttons[0].click())
    assert.equal(sent[0].text,'历史回复。')
    await act(async()=>buttons[1].click())
    assert.deepEqual(sent[1],{type:'stop',id:sent[0].id})
    assert.equal(sent[2].text,'最新回复。')
    assert.equal(host.querySelectorAll('button[aria-label="停止朗读"]').length,1)
    await act(async()=> (window as any).WorkStepSpeech.onmessage({data:JSON.stringify({id:sent[2].id,status:'error',error:'手机未安装中文音色'})}))
    assert.match(host.querySelector('[role="alert"]')!.textContent!,/手机未安装中文音色/)
    await act(async()=>window.dispatchEvent(new window.Event(OUTPUT_CHANGED)))
    assert.equal(reads,2,'one shared refresh for both replies')
    await act(async()=>buttons[1].click())
    const last = sent.at(-1)!
    assert.equal(last.text,'最新回复。')
    await act(async()=>root.unmount())
    assert.deepEqual(sent.at(-1),{type:'stop',id:last.id})
  }finally{speechOutputApi.status=original;await window.happyDOM.close()}
})
