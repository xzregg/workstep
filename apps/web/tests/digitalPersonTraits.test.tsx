import {installDomEnvironment} from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {MemoryRouter} from 'react-router-dom'
import {I18nProvider,useLocaleStore} from '../src/i18n'
import {digitalPersonApi,digitalRuntimeApi,type DigitalPersonProfile} from '../src/api/digitalPerson'
import DigitalPersonSettings from '../src/components/digital-person/DigitalPersonSettings'

test('identity, personality and tone allow multiple presets and free text, then persist together',async()=>{
 const {window}=installDomEnvironment(),el=document.body.appendChild(document.createElement('div')),root=createRoot(el)
 useLocaleStore.setState({locale:'zh-CN'})
 const oldGet=digitalPersonApi.get,oldSave=digitalPersonApi.save,oldActivity=digitalRuntimeApi.activity
 let profile:DigitalPersonProfile={enabled:false,onboarding_completed:true,name:'小研',role:'自定义身份',personality:'自定义性格',duties:'跟进研发',avatar:'robot',greeting:'你好',role_binding:{kind:'role',id:'rd'}}
 digitalPersonApi.get=async()=>({...profile})
 digitalPersonApi.save=async value=>{profile={...value};return profile}
 digitalRuntimeApi.activity=async()=>({level:1,experience:0,next_level_experience:10,feedback:{},suggestions:[],runs:[],answers:[],delegations:[],checking:false})
 const click=async(name:string)=>act(async()=>{
  const button=[...el.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===name)
  assert.ok(button,name);button.click()
 })
 try{
  await act(async()=>root.render(<MemoryRouter><I18nProvider><DigitalPersonSettings onClose={()=>{}}/></I18nProvider></MemoryRouter>))
  await click('身份与职责')
  await click('研发伙伴');await click('项目管家')
  assert.equal(el.querySelector('[aria-label="身份"]')!.getAttribute('name'),'role')
  assert.match((el.querySelector('[name="role"]') as HTMLInputElement).value,/自定义身份、研发伙伴、项目管家/)
  await click('严谨');await click('耐心')
  await click('专业克制');await click('轻松幽默')
  const tone=el.querySelector<HTMLInputElement>('[name="tone"]')!
  await act(async()=>{
   Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(tone,'专业克制、自定义语气')
   tone.dispatchEvent(new window.Event('input',{bubbles:true}))
  })
  await click('专业克制')
  assert.equal(tone.value,'自定义语气')
  await click('保存')
  assert.equal(profile.role,'自定义身份、研发伙伴、项目管家')
  assert.equal(profile.personality,'自定义性格、严谨、耐心')
  assert.equal(profile.tone,'自定义语气')
  assert.equal(profile.role_binding,null)
  await click('编辑档案')
  assert.equal(el.querySelector<HTMLInputElement>('[name="tone"]')!.value,'自定义语气')
 }finally{await act(async()=>root.unmount());digitalPersonApi.get=oldGet;digitalPersonApi.save=oldSave;digitalRuntimeApi.activity=oldActivity;await window.happyDOM.close()}
})
