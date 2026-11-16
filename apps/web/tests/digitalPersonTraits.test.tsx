import {installDomEnvironment} from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {MemoryRouter} from 'react-router-dom'
import {I18nProvider,useLocaleStore} from '../src/i18n'
import {digitalPersonApi,digitalRuntimeApi,type DigitalPersonProfile} from '../src/api/digitalPerson'
import DigitalPersonSettings from '../src/components/digital-person/DigitalPersonSettings'

test('three shared Markdown editors preserve old values and handwritten text while presets persist to matching documents',async()=>{
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
  await click('人设与职责')
  assert.equal(el.querySelectorAll('.digital-person-documents .markdown-editor-root').length,3)
  const editor=(label:string)=>el.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)!
  assert.match(editor('人设').value,/自定义身份/)
  assert.match(editor('人设').value,/自定义性格/)
  assert.match(editor('职责').value,/跟进研发/)
  await act(async()=>{
   const field=editor('人设')
   Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')!.set!.call(field,field.value+'\n\n## 我的补充\n不要叫我老板。')
   field.dispatchEvent(new window.Event('input',{bubbles:true}))
  })
  await click('研发伙伴')
  await click('严谨');await click('耐心')
  await click('专业克制')
  assert.match(editor('人设').value,/不要叫我老板/)
  assert.match(editor('人设').value,/研发伙伴/)
  assert.match(editor('人设').value,/严谨/)
  const dutiesBefore=editor('职责').value
  await click('说明不确定性')
  assert.match(editor('记忆').value,/信息不确定时/)
  assert.equal(editor('职责').value,dutiesBefore)
  await click('保存')
  assert.match(profile.persona_markdown!,/不要叫我老板/)
  assert.match(profile.conversation_rules!,/信息不确定时/)
  assert.equal(profile.role_binding,null)
  assert.equal(el.querySelectorAll('.digital-person-documents .markdown-editor-root').length,3)
 }finally{await act(async()=>root.unmount());digitalPersonApi.get=oldGet;digitalPersonApi.save=oldSave;digitalRuntimeApi.activity=oldActivity;await window.happyDOM.close()}
})
