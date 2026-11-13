import {installDomEnvironment} from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {MemoryRouter} from 'react-router-dom'
import {I18nProvider,useLocaleStore} from '../src/i18n'
import DigitalPersonWorkspace from '../src/components/digital-person/DigitalPersonWorkspace'
import {digitalRuntimeApi,voiceWakeApi} from '../src/api/digitalPerson'
import {useWakeState} from '../src/components/digital-person/digitalPersonWakeState'
const profile={enabled:true,name:'小研',role:'研发伙伴',personality:'直接',duties:'指派任务',avatar:'robot' as const,greeting:'今天需要我做什么？',proactive_enabled:true,proactive_interval_minutes:30}
const activity={feedback:{},suggestions:[],experience:14,level:2,next_level_experience:40,checking:false,runs:[],delegations:[],answers:[]}
test('workspace preserves chat and derives presence from actual running and wake state',async()=>{
 const {window}=installDomEnvironment(),el=document.body.appendChild(document.createElement('div')),root=createRoot(el)
 useLocaleStore.setState({locale:'zh-CN'});useWakeState.setState({listening:false})
 const render=(running=false,p:any=profile)=>act(async()=>root.render(<MemoryRouter><I18nProvider><DigitalPersonWorkspace profile={p} activity={activity} running={running}><div data-chat>原有会话</div></DigitalPersonWorkspace></I18nProvider></MemoryRouter>))
 try{
  await render();assert.ok(el.querySelector('[data-chat]'));assert.equal(el.querySelector('[data-state]')!.getAttribute('data-state'),'idle')
  await render(true);assert.equal(el.querySelector('[data-state]')!.getAttribute('data-state'),'thinking')
  await act(async()=>useWakeState.setState({listening:true,phase:'recording'}));assert.equal(el.querySelector('[data-state]')!.getAttribute('data-state'),'listening')
  await render(false,null);assert.equal(el.querySelector('.digital-person-workspace'),null);assert.ok(el.querySelector('[data-chat]'))
 }finally{await act(async()=>root.unmount());useWakeState.setState({listening:false});await window.happyDOM.close()}
})
test('manual check reports failure honestly, microphone is started only after a user action',async()=>{
 const {window}=installDomEnvironment(),el=document.body.appendChild(document.createElement('div')),root=createRoot(el)
 useLocaleStore.setState({locale:'zh-CN'});useWakeState.setState({listening:false})
 const oldCheck=digitalRuntimeApi.check,oldWake=voiceWakeApi.get;let checks=0,wakeReads=0
 digitalRuntimeApi.check=async()=>{checks++;return {status:'failed',error:'引擎暂不可用'}}
 voiceWakeApi.get=async()=>{wakeReads++;return {keyword:'你好小研',sensitivity:'balanced',available:false,listening:false}}
 try{
  await act(async()=>root.render(<MemoryRouter><I18nProvider><DigitalPersonWorkspace profile={profile} activity={activity} running={false}><div>聊天</div></DigitalPersonWorkspace></I18nProvider></MemoryRouter>))
  assert.equal(wakeReads,0)
  assert.ok(el.querySelector('[data-console-listen]')!.closest('.digital-console-presence'))
  assert.equal(el.querySelector('.digital-console-command-bar'),null)
  await act(async()=>el.querySelector<HTMLButtonElement>('[data-console-check]')!.click())
  assert.equal(checks,1);assert.match(el.querySelector('[role="alert"]')!.textContent!,/引擎暂不可用/)
  for (const [status,label] of [['delivery_failed','投递失败'],['deferred','免打扰延后'],['cancelled','已取消']]) {
   digitalRuntimeApi.check=async()=>({status})
   await act(async()=>el.querySelector<HTMLButtonElement>('[data-console-check]')!.click())
   assert.equal(el.querySelector('[role="status"]')!.textContent,label)
  }
  await act(async()=>el.querySelector<HTMLButtonElement>('[data-console-listen]')!.click())
  assert.equal(wakeReads,1);assert.equal(useWakeState.getState().listening,true)
  await act(async()=>el.querySelector<HTMLButtonElement>('[data-console-listen]')!.click())
  assert.equal(useWakeState.getState().listening,false)
 }finally{await act(async()=>root.unmount());digitalRuntimeApi.check=oldCheck;voiceWakeApi.get=oldWake;useWakeState.setState({listening:false});await window.happyDOM.close()}
})
