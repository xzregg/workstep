import { installDomEnvironment } from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import DecisionServiceModels from '../src/components/DecisionServiceModels'
import { decisionModelsApi } from '../src/api/decisionModels'

function button(text: string) { return [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === text)! }
test('model discovery is explicit, searchable and does not choose or save automatically', async () => {
 const { window } = installDomEnvironment();const root=createRoot(document.body.appendChild(document.createElement('div')))
 const original={...decisionModelsApi};let reads=0;let selected='';let signal: AbortSignal | undefined
 decisionModelsApi.models=async (source, abort) => { reads++;signal=abort;assert.equal(source.api_key,null);return { models:['laya','d1-2B','kev-4B'] } }
 try {
  await act(async()=>root.render(<I18nProvider><DecisionServiceModels source={{mode:'local',base_url:'http://127.0.0.1:6000',api_key:null}} value="" disabled={false} onSelect={v=>{selected=v}} /></I18nProvider>))
  assert.equal(reads,0)
  await act(async()=>button('读取模型列表').click())
  assert.equal(reads,1);assert.equal(selected,'')
  await act(async()=>document.querySelector<HTMLButtonElement>('button[role="combobox"]')!.click())
  const search=document.querySelector<HTMLInputElement>('input[type="search"]')!
  await act(async()=>{Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(search,'kev');search.dispatchEvent(new window.Event('input',{bubbles:true}))})
  const options=[...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
  assert.equal(options.length,1);assert.equal(options[0].textContent,'kev-4B')
  await act(async()=>options[0].click())
  assert.equal(selected,'kev-4B')
  await act(async()=>root.render(<I18nProvider><DecisionServiceModels source={{mode:'remote',base_url:'https://other.example',api_key:null}} value="manual-model" disabled={false} onSelect={()=>{}} /></I18nProvider>))
  assert.equal(document.querySelector('button[role="combobox"]'),null)
  assert.equal(reads,1);assert.equal(signal?.aborted,true)
 } finally {Object.assign(decisionModelsApi,original);await act(async()=>root.unmount());await window.happyDOM.close()}
})

test('failed or stale discovery preserves manual choice and supports retry', async () => {
 const {window}=installDomEnvironment();const root=createRoot(document.body.appendChild(document.createElement('div')))
 const original={...decisionModelsApi};let change=0;let fail=true
 decisionModelsApi.models=async()=>{if(fail)throw Error('服务不支持读取模型列表，请手动填写模型');return {models:[]}}
 const render=()=>root.render(<I18nProvider><DecisionServiceModels source={{mode:'remote',base_url:'https://example.com',api_key:null}} value="manual-model" disabled={false} onSelect={()=>{change++}} /></I18nProvider>)
 try {
  await act(async()=>render());await act(async()=>button('读取模型列表').click())
  assert.match(document.querySelector('[role="alert"]')!.textContent!,/手动填写/);assert.equal(change,0)
  fail=false;await act(async()=>button('读取模型列表').click())
  assert.match(document.body.textContent!,/未返回可用模型/);assert.equal(change,0)
 } finally {Object.assign(decisionModelsApi,original);await act(async()=>root.unmount());await window.happyDOM.close()}
})


test('a pending response from old credentials cannot repopulate the changed source', async () => {
 const {window}=installDomEnvironment();const root=createRoot(document.body.appendChild(document.createElement('div')))
 const original={...decisionModelsApi};let resolve!: (value:{models:string[]})=>void;let signal:AbortSignal | undefined
 decisionModelsApi.models=async(_source,abort)=>{signal=abort;return new Promise(done=>{resolve=done})}
 const render=(url:string)=>root.render(<I18nProvider><DecisionServiceModels source={{mode:'local',base_url:url,api_key:null}} value="manual" disabled={false} onSelect={()=>{assert.fail('unexpected selection')}} /></I18nProvider>)
 try {
  await act(async()=>render('http://127.0.0.1:6000'))
  await act(async()=>button('读取模型列表').click())
  await act(async()=>render('http://127.0.0.1:6001'))
  assert.equal(signal?.aborted,true)
  await act(async()=>resolve({models:['stale-model']}))
  assert.equal(document.querySelector('button[role="combobox"]'),null)
  assert.doesNotMatch(document.body.textContent!,/stale-model/)
  assert.equal(button('读取模型列表').disabled,false)
 } finally {Object.assign(decisionModelsApi,original);await act(async()=>root.unmount());await window.happyDOM.close()}
})
