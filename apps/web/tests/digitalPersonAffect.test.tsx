import {installDomEnvironment} from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {MemoryRouter} from 'react-router-dom'
import {I18nProvider} from '../src/i18n'
import {RelationshipReadout} from '../src/components/digital-person/DigitalPersonRelationship'
import {digitalAffectApi} from '../src/api/digitalPerson'

const state={person_id:'alice',name:'Alice',affinity:63,emotion:'happy',valence:35,arousal:40,updated_at:'2026-11-14T01:00:00Z',history:[{id:1,project_id:'p',session_id:'s',source_ids:['u'],kind:'chat',delta:1,before_value:62,after_value:63,emotion:'happy',reason:'一起解决了问题',at:'2026-11-14T01:00:00Z'}]}
test('relationship shows metrics and latest change without folding or technical notes',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 try{
  await act(async()=>root.render(<MemoryRouter><I18nProvider><RelationshipReadout state={state}/></I18nProvider></MemoryRouter>))
  assert.match(host.textContent!,/63/);assert.match(host.textContent!,/开心/)
  assert.equal(host.querySelector('details,summary,input,textarea,select'),null)
  assert.doesNotMatch(host.textContent!,/只读|随相处积累/)
  assert.match(host.querySelector('.digital-affect-recent')!.textContent!,/一起解决了问题/)
  assert.equal(host.querySelector('.digital-affect-detail'),null)
  await act(async()=>host.querySelector<HTMLButtonElement>('.digital-affect-recent button')!.click())
  assert.ok(host.querySelector('.digital-affect-detail time'))
  assert.match(host.textContent!,/62 → 63/)
 }finally{await act(async()=>root.unmount());await window.happyDOM.close()}
})

test('overlapping refresh waits for the old request and never shows the previous speaker',async()=>{
 const {useDigitalPersonAffect}=await import('../src/components/digital-person/useDigitalPersonAffect')
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const original=digitalAffectApi.read,requests:Array<{person:string;resolve:(value:any)=>void}>=[]
 digitalAffectApi.read=options=>new Promise(resolve=>requests.push({person:options.person_id??'',resolve}))
 function Read({person}:{person:string}){const result=useDigitalPersonAffect(undefined,undefined,'',person);return <span>{result.state?.name??'loading'}</span>}
 try{
  await act(async()=>root.render(<Read person="alice"/>))
  await act(async()=>root.render(<Read person="bob"/>))
  assert.equal(requests.length,1)
  await act(async()=>requests[0].resolve({state:{...state,name:'Alice'}}))
  assert.equal(requests.length,2);assert.equal(requests[1].person,'bob')
  assert.doesNotMatch(host.textContent!,/Alice/)
  await act(async()=>requests[1].resolve({state:{...state,name:'Bob'}}))
  assert.equal(host.textContent,'Bob')
 }finally{await act(async()=>root.unmount());digitalAffectApi.read=original;await window.happyDOM.close()}
})
