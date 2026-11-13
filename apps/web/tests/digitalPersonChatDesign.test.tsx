import {installDomEnvironment} from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {I18nProvider} from '../src/i18n'
import {digitalRuntimeApi} from '../src/api/digitalPerson'
import DigitalPersonFeedback from '../src/components/digital-person/DigitalPersonFeedback'
import DigitalPersonCompanion from '../src/components/digital-person/DigitalPersonCompanion'
import MessageResponseFooter from '../src/components/MessageResponseFooter'
const profile={enabled:true,name:'小研',role:'研发伙伴',personality:'直接',duties:'研发',avatar:'robot' as const,greeting:'你好'}
test('feedback uses accessible icons in shared footer and toggles without duplicate submission',async()=>{
 const {window}=installDomEnvironment(),el=document.body.appendChild(document.createElement('div')),root=createRoot(el)
 const old=digitalRuntimeApi.feedback;const votes:number[]=[]
 digitalRuntimeApi.feedback=async(_,value)=>{votes.push(value);return {} as any}
 try{
  await act(async()=>root.render(<I18nProvider><MessageResponseFooter content="你好" engine="codex" model="gpt-6" compact actions={<DigitalPersonFeedback messageId="m"/>}/></I18nProvider>))
  const helpful=el.querySelector<HTMLButtonElement>('[aria-label="有帮助"]')!
  assert.ok(helpful);assert.ok(helpful.querySelector('svg'));assert.equal(helpful.textContent,'')
  assert.ok(el.querySelector('.message-response-footer')!.contains(helpful))
  await act(async()=>helpful.click());assert.deepEqual(votes,[1]);assert.equal(helpful.getAttribute('aria-pressed'),'true')
  await act(async()=>helpful.click());assert.deepEqual(votes,[1,0])
  const details=el.querySelector('details')!;assert.ok(details);assert.equal(details.open,false)
  details.open=true;assert.match(details.textContent!,/gpt-6/)
 }finally{await act(async()=>root.unmount());digitalRuntimeApi.feedback=old;await window.happyDOM.close()}
})
test('unsupported voice shows compact identity without a dead action or explanatory error',async()=>{
 const {window}=installDomEnvironment(),el=document.body.appendChild(document.createElement('div')),root=createRoot(el)
 Object.defineProperty(window,'speechSynthesis',{configurable:true,value:undefined})
 try{
  await act(async()=>root.render(<I18nProvider><DigitalPersonCompanion profile={profile} replyId="m" reply="你好"/></I18nProvider>))
  assert.equal(el.querySelector('button'),null)
  assert.equal(el.querySelector('[role="alert"]'),null)
  assert.match(el.textContent!,/小研/)
  assert.doesNotMatch(el.textContent!,/不支持|试听|朗读/)
 }finally{await act(async()=>root.unmount());await window.happyDOM.close()}
})
