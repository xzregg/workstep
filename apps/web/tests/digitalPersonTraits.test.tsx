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
 let profile:DigitalPersonProfile={enabled:false,onboarding_completed:true,name:'小研',role:'自定义身份',personality:'自定义性格',tone:'年轻女声，音色柔和清晰。',duties:'跟进研发',avatar:'robot',greeting:'你好',role_binding:{kind:'role',id:'rd'}}
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
  const edit=(label:string,text:string)=>act(async()=>{
   const field=editor(label)
   Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')!.set!.call(field,text)
   field.dispatchEvent(new window.Event('input',{bubbles:true}))
  })
  const customTrait='耐心，先问原因；遇到分歧时给出证据。'
  const customTone='年轻女声，音色柔和清晰。\n说话温柔、沉稳，语速稍慢。'
  const customRelationship='不要叫我老板。\n先听我说完。'
  const customDuty='## 主要职责\n\n1. **跟进研发**\n   - 每周汇总一次\n\n> 等我确认再发出。'
  const customMemory='## 长期约定\n\n- **重要事项**\n  先问我再记。'
  await edit('人设',editor('人设').value.replace('自定义性格',customTrait).replace(profile.tone!,customTone)
    .replace('## 相处\n自然平衡',`## 相处\n自然平衡\n\n${customRelationship}`)+'\n\n## 我的补充\n保留这段。')
  const existingDuties=customDuty+'\n\n- 澄清需求，明确目标与验收标准。'
  await edit('职责',existingDuties)
  await edit('记忆',customMemory)
  await click('学习搭档')
  assert.equal(editor('职责').value,existingDuties)
  await click('研发伙伴')
  assert.equal(editor('职责').value,existingDuties)
  await click('严谨');await click('耐心')
  await click('专业克制')
  await click('温和亲切')
  await click('温和亲近')
  assert.ok(editor('人设').value.includes(customRelationship))
  assert.doesNotMatch(editor('人设').value,/自然平衡|学习搭档/)
  await click('澄清需求')
  assert.ok(editor('职责').value.includes(customDuty))
  await click('澄清需求')
  assert.ok(editor('职责').value.includes(customDuty))
  assert.ok(editor('人设').value.includes(customTone))
  assert.ok(editor('人设').value.includes(customTrait))
  assert.doesNotMatch(editor('人设').value,/专业克制/)
  assert.match(editor('人设').value,/不要叫我老板/)
  assert.match(editor('人设').value,/研发伙伴/)
  assert.match(editor('人设').value,/严谨/)
  const dutiesBefore=editor('职责').value
  await click('说明不确定性')
  assert.ok(editor('记忆').value.includes(customMemory))
  await click('说明不确定性')
  assert.equal(editor('记忆').value,customMemory)
  await click('说明不确定性')
  assert.match(editor('记忆').value,/信息不确定时/)
  assert.equal(editor('职责').value,dutiesBefore)
  await click('保存')
  assert.match(profile.persona_markdown!,/不要叫我老板/)
  assert.match(profile.persona_markdown!,/保留这段/)
  assert.match(profile.persona_markdown!,/自定义身份/)
  assert.ok(profile.tone?.includes(customTone))
  assert.ok(profile.duties.includes(customDuty))
  assert.match(profile.conversation_rules!,/信息不确定时/)
  assert.equal(profile.role_binding,null)
  assert.equal(el.querySelectorAll('.digital-person-documents .markdown-editor-root').length,3)
 }finally{await act(async()=>root.unmount());digitalPersonApi.get=oldGet;digitalPersonApi.save=oldSave;digitalRuntimeApi.activity=oldActivity;await window.happyDOM.close()}
})
