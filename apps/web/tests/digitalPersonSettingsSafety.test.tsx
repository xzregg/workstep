import {installDomEnvironment} from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {MemoryRouter} from 'react-router-dom'
import {I18nProvider,useLocaleStore} from '../src/i18n'
import {digitalPersonApi,digitalRuntimeApi,voiceWakeApi} from '../src/api/digitalPerson'
import Settings from '../src/components/digital-person/DigitalPersonSettings'
import SettingsPage from '../src/pages/SettingsPage'

const profile={enabled:true,onboarding_completed:true,name:'原姓名',role:'伙伴',personality:'严谨',duties:'跟进工作',avatar:'robot' as const,greeting:'你好'}
test('memory batch size defaults to 100 and validates and saves the edited limit',async()=>{
 const ui=await setup()
 try{
  await ui.click('[data-body-part=brain]')
  await ui.click('[data-body-part=memory]')
  const selector='[name=memory_batch_size]'
  assert.equal(ui.host.querySelector(selector),null,'memory page only displays memory content')
  await ui.click('[data-body-part=heart]')
  assert.equal(ui.host.querySelector<HTMLInputElement>(selector)!.value,'100')
  for(const invalid of ['', '0', '1001', '1.5']){
   await ui.input(selector,invalid)
   assert.equal(ui.host.querySelector<HTMLButtonElement>('.digital-person-form-actions button')!.disabled,true)
  }
  await ui.input(selector,'60')
  await ui.click('.digital-person-form-actions button')
  assert.equal((ui.getSaved() as any).memory_batch_size,60)
  assert.equal(ui.host.querySelector<HTMLInputElement>(selector)!.value,'60')
 }finally{await ui.close()}
})
async function setup(enabled=true, outer=false){
 const {window}=installDomEnvironment();useLocaleStore.setState({locale:'zh-CN'})
 const host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const originals=[{...digitalPersonApi},{...digitalRuntimeApi},{...voiceWakeApi}]
 let saved={...profile,enabled},closes=0,externalBusy=false
 digitalPersonApi.get=async()=>({...saved})
 digitalPersonApi.save=async value=>(saved={...value} as typeof saved)
 digitalRuntimeApi.activity=async()=>({feedback:{},suggestions:[],runs:[],answers:[],delegations:[],checking:false}) as any
 digitalRuntimeApi.records=async()=>({runs:[],delegations:[],checking:false,run_total:0,delegation_total:0})
 const click=async(selector:string)=>act(async()=>{const el=document.querySelector<HTMLButtonElement>(selector);assert.ok(el,selector);el.click()})
 const input=async(selector:string,value:string)=>act(async()=>{const el=host.querySelector<HTMLInputElement|HTMLTextAreaElement>(selector)!;Object.getOwnPropertyDescriptor(el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype,'value')!.set!.call(el,value);el.dispatchEvent(new window.Event('input',{bubbles:true}))})
 Object.assign(globalThis,{history:window.history,location:window.location})
 await act(async()=>root.render(<MemoryRouter><I18nProvider>{outer ? <SettingsPage initialSection="digital-person" onClose={()=>closes++}/> : <Settings onClose={()=>closes++} onBusyChange={value=>{externalBusy=value}}/>}</I18nProvider></MemoryRouter>))
 return {host,click,input,getSaved:()=>saved,closes:()=>closes,busy:()=>externalBusy,close:async()=>{await act(async()=>root.unmount());await window.happyDOM.close();Object.assign(digitalPersonApi,originals[0]);Object.assign(digitalRuntimeApi,originals[1]);Object.assign(voiceWakeApi,originals[2])}}
}

test('enabling with unsaved profile requires confirmation and cancellation retains edits',async()=>{
 const ui=await setup(false)
 try{
  await ui.click('[data-settings-tab=identity]');await ui.input('[name=name]','新姓名')
  await ui.click('.digital-person-header [role=switch]')
  assert.equal(ui.closes(),0);assert.equal(ui.getSaved().enabled,false)
  assert.ok(document.querySelector('.confirm-dialog-confirm'))
  await act(async()=>[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='取消')!.click())
  assert.equal(ui.host.querySelector<HTMLInputElement>('[name=name]')!.value,'新姓名')
  await ui.click('.digital-person-header [role=switch]');await ui.click('.confirm-dialog-confirm')
  assert.equal(ui.getSaved().enabled,true);assert.equal(ui.getSaved().name,'原姓名');assert.equal(ui.closes(),1)
 }finally{await ui.close()}
})

test('pending child save locks navigation and the outer dialog until it settles',async()=>{
 const ui=await setup();let release!:()=>void,keyword='你好小研'
 voiceWakeApi.get=async()=>({keyword,sensitivity:'balanced'}) as any
 voiceWakeApi.save=async value=>{await new Promise<void>(r=>release=r);keyword=value.keyword;return value as any}
 try{
  await ui.click('[data-body-part=ears]');await ui.click('#speech-tab-wake');await ui.input('.voice-wake-settings input[name=wake_keyword]','新唤醒词');await ui.click('[data-save-wake]')
  assert.equal(ui.busy(),true)
  await ui.click('[data-body-part=feet]')
  assert.ok(ui.host.querySelector('.voice-wake-settings'));assert.equal(document.querySelector('.confirm-dialog-confirm'),null)
  assert.equal(ui.host.querySelector<HTMLButtonElement>('.digital-person-header [role=switch]')!.disabled,true)
  await act(async()=>release());assert.equal(ui.busy(),false)
  await ui.click('[data-body-part=feet]');assert.ok(ui.host.querySelector('.digital-person-activity'));assert.equal(keyword,'新唤醒词')
 }finally{await ui.close()}
})

test('saving proactive settings keeps the current panel and saved switch state',async()=>{
 const ui=await setup()
 try{
  await ui.click('[data-body-part=heart]')
  await ui.click('[name=proactive_enabled]')
  await ui.click('.digital-person-form-actions button')
  assert.equal(ui.getSaved().proactive_enabled,true)
  assert.equal(ui.host.querySelector('#digital-person-panel-title')!.textContent,'主动思考')
  assert.equal(ui.host.querySelector<HTMLInputElement>('[name=proactive_enabled]')!.checked,true)
  assert.equal(ui.host.querySelector<HTMLButtonElement>('.digital-person-form-actions button')!.disabled,true)
  assert.equal(ui.closes(),0)
  await ui.input('.digital-person-form textarea','继续编辑主动思考')
  await ui.click('.digital-person-form-actions button')
  assert.equal(ui.getSaved().proactive_instruction,'继续编辑主动思考')
  assert.equal(ui.host.querySelector('[data-body-part=heart]')!.getAttribute('aria-pressed'),'true')
 }finally{await ui.close()}
})

test('numeric settings can be cleared and retyped without inserting zero',async()=>{
 const ui=await setup()
 try{
  await ui.click('[data-body-part=heart]')
  const selectors=['[name=proactive_contact_interval_minutes]','[name=proactive_interval_minutes]']
  for(const selector of selectors){
   await ui.input(selector,'')
   assert.equal(ui.host.querySelector<HTMLInputElement>(selector)!.value,'')
   assert.equal(ui.host.querySelector<HTMLButtonElement>('.digital-person-form-actions button')!.disabled,true)
   await ui.input(selector,'12')
   assert.equal(ui.host.querySelector<HTMLInputElement>(selector)!.value,'12')
   assert.equal(ui.host.querySelector<HTMLButtonElement>('.digital-person-form-actions button')!.disabled,false)
  }
  await ui.click('.digital-person-form-actions button')
  assert.equal(ui.getSaved().proactive_contact_interval_minutes,12)
  assert.equal(ui.getSaved().proactive_interval_minutes,12)
 }finally{await ui.close()}
})

test('automatic thinking can be disabled without disabling the persona or manual check',async()=>{
 const ui=await setup();let checks=0
 digitalRuntimeApi.check=async()=>{checks++;return {status:'silent'} as any}
 try{
  await ui.click('[data-body-part=heart]')
  assert.equal(ui.host.querySelector<HTMLInputElement>('[name=reflection_enabled]')!.checked,true)
  assert.equal(ui.host.querySelector('[name=delegation_interval_seconds]'),null)
  await ui.click('[name=reflection_enabled]')
  await ui.click('.digital-person-form-actions button')
  assert.equal((ui.getSaved() as any).reflection_enabled,false)
  assert.equal(ui.getSaved().enabled,true)
  const button=[...ui.host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='立即思考')!
  assert.ok(button);assert.equal(button.disabled,false)
  await act(async()=>button.click())
  assert.equal(checks,1)
 }finally{await ui.close()}
})

test('saving identity also stays on the same panel',async()=>{
 const ui=await setup()
 try{
  await ui.click('[data-settings-tab=identity]');await ui.input('[name=name]','新姓名');await ui.click('.digital-person-form-actions button')
  assert.equal(ui.getSaved().name,'新姓名')
  assert.equal(ui.host.querySelector<HTMLInputElement>('[name=name]')!.value,'新姓名')
  assert.equal(ui.host.querySelector('[data-settings-tab=identity]')!.getAttribute('aria-pressed'),'true')
  assert.equal(ui.closes(),0)
 }finally{await ui.close()}
})

test('profile controls stay disabled during save and recover after failure',async()=>{
 const ui=await setup();let fail!:(e:Error)=>void
 digitalPersonApi.save=()=>new Promise((_resolve,reject)=>{fail=reject})
 try{
  await ui.click('[data-body-part=heart]');await ui.input('.digital-person-form textarea','修改职责');await ui.click('.digital-person-form-actions button')
  for(const control of ui.host.querySelectorAll<HTMLInputElement|HTMLTextAreaElement>('.digital-person-form input,.digital-person-form textarea'))assert.equal(control.disabled,true)
  assert.equal(ui.busy(),true)
  await act(async()=>fail(Error('保存失败')))
  assert.equal(ui.busy(),false);assert.equal(ui.host.querySelector<HTMLTextAreaElement>('.digital-person-form textarea')!.value,'修改职责')
  assert.equal(ui.host.querySelector<HTMLTextAreaElement>('.digital-person-form textarea')!.disabled,false)
 }finally{await ui.close()}
})

test('proactive check runs once and opens records, surfacing failure without losing configuration',async()=>{
 const ui=await setup();let calls=0,fail!:(e:Error)=>void
 digitalRuntimeApi.check=()=>{calls++;return new Promise((_resolve,reject)=>{fail=reject})}
 try{
  await ui.click('[data-body-part=heart]')
  await act(async()=>[...ui.host.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='立即思考')!.click())
  assert.equal(calls,1);assert.ok(ui.host.querySelector('.digital-person-activity'));assert.equal(ui.busy(),true)
  assert.equal(ui.host.querySelector<HTMLButtonElement>('.digital-person-activity-toolbar .btn-primary')!.disabled,true)
  await act(async()=>fail(Error('检查失败')))
  assert.equal(ui.busy(),false);assert.match(ui.host.textContent!,/检查失败/)
 }finally{await ui.close()}
})

test('outer settings cannot close, escape or change sections while a child save is pending',async()=>{
 const ui=await setup(true,true);let release!:()=>void
 voiceWakeApi.get=async()=>({keyword:'你好小研',sensitivity:'balanced'}) as any
 voiceWakeApi.save=async value=>{await new Promise<void>(r=>release=r);return value as any}
 try{
  await ui.click('[data-body-part=ears]');await ui.click('#speech-tab-wake');await ui.input('.voice-wake-settings input[name=wake_keyword]','新的唤醒词');await ui.click('[data-save-wake]')
  assert.equal(ui.host.querySelector<HTMLButtonElement>('.settings-dialog-header .btn-icon')!.disabled,true)
  await ui.click('.settings-dialog-header .btn-icon')
  await ui.click('.settings-nav button:not([aria-current=page])')
  await act(async()=>document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
  assert.equal(ui.closes(),0);assert.equal(document.querySelector('.confirm-dialog-confirm'),null);assert.ok(ui.host.querySelector('.voice-wake-settings'))
  await act(async()=>release())
  await ui.click('.settings-dialog-header .btn-icon');assert.equal(ui.closes(),1)
 }finally{await ui.close()}
})


test('contact interval is visible, bounded and saved independently of the thinking cadence',async()=>{
 const ui=await setup()
 try{
  await ui.click('[data-body-part=heart]')
  const selector='[name=proactive_contact_interval_minutes]'
  assert.equal(ui.host.querySelector<HTMLInputElement>(selector)!.value,'5')
  await ui.input(selector,'0')
  assert.equal(ui.host.querySelector<HTMLButtonElement>('.digital-person-form-actions button')!.disabled,true)
  await ui.input(selector,'30')
  await ui.click('.digital-person-form-actions button')
  assert.equal(ui.getSaved().proactive_contact_interval_minutes,30)
  assert.equal(ui.host.querySelector<HTMLInputElement>('[name=proactive_interval_minutes]')!.value,'5')
 }finally{await ui.close()}
})


test('digital-person settings keeps one dialog and navigation while content changes',async()=>{
 const ui=await setup(true,true)
 try{
  const dialog=ui.host.querySelector('.settings-dialog-panel')
  assert.ok(ui.host.querySelector('.settings-layout--digital-person'))
  for(const part of ['brain','memory','ears','feet']){
   await ui.click(`[data-body-part=${part}]`)
   assert.equal(ui.host.querySelector('.settings-dialog-panel'),dialog)
   assert.ok(ui.host.querySelector('.settings-layout--digital-person'))
   assert.equal(ui.host.querySelectorAll('.digital-person-body-image').length,1)
  }
  await ui.click('[data-settings-navigation-toggle]')
  assert.equal(ui.host.querySelector('.settings-layout--digital-person'),null)
  await ui.click('[data-settings-navigation-toggle]')
  assert.ok(ui.host.querySelector('.settings-layout--digital-person'))
  await ui.click('.digital-person-secondary-nav [data-settings-tab=identity]')
  assert.ok(ui.host.querySelector('.settings-layout--digital-person'))
 }finally{await ui.close()}
})

test('quiet hours offer labelled times and save numeric hours including midnight',async()=>{
 const ui=await setup()
 try{
  await ui.click('[data-body-part=heart]')
  for(const [name,initial,next] of [['quiet_start','22','0'],['quiet_end','8','23']]){
   const select=ui.host.querySelector<HTMLSelectElement>(`select[name=${name}]`)
   assert.ok(select)
   assert.equal(select.value,initial)
   assert.equal(select.options.length,24)
   assert.equal(select.options[0].textContent,'00:00')
   assert.equal(select.options[23].textContent,'23:00')
   await act(async()=>{select.value=next;select.dispatchEvent(new window.Event('change',{bubbles:true}))})
  }
  await ui.click('.digital-person-form-actions button')
  assert.equal(ui.getSaved().quiet_start,0)
  assert.equal(ui.getSaved().quiet_end,23)
  assert.equal(ui.host.querySelector<HTMLSelectElement>('[name=quiet_start]')!.value,'0')
 }finally{await ui.close()}
})
