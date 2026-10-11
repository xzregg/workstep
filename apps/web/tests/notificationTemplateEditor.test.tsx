import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import NotificationTemplateEditor from '../src/components/NotificationTemplateEditor'

test('template editor edits, validates, copies variables and restores only after confirmation', async()=>{
  const {window,document}=installDomEnvironment()
  useLocaleStore.getState().setLocale('zh-CN')
  let value:string|null=null
  const copied:string[]=[]
  Object.defineProperty(window.navigator,'clipboard',{configurable:true,value:{writeText:async(text:string)=>{copied.push(text)}}})
  const defaults='### {notification_title}\n\n**事件：{event_name}**'
  function Harness(){
    const [current,setCurrent]=useState<string|null>(null)
    return <NotificationTemplateEditor value={current} defaultTemplate={defaults} variables={['notification_title','event_name']} disabled={false} onChange={next=>{value=next;setCurrent(next)}}/>
  }
  const root=createRoot(document.body.appendChild(document.createElement('div')))
  const click=async(text:string)=>{
    const button=[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===text)
    assert.ok(button,text);await act(async()=>button.click())
  }
  const edit=async(text:string)=>{
    const input=document.querySelector<HTMLTextAreaElement>('textarea')!
    await act(async()=>{
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')!.set!.call(input,text)
      input.dispatchEvent(new window.Event('input',{bubbles:true}))
    })
  }
  try{
    await act(async()=>root.render(<I18nProvider><Harness/></I18nProvider>))
    assert.equal(document.querySelector<HTMLTextAreaElement>('textarea')!.value,defaults)
    await edit('{unknown}')
    assert.match(document.querySelector('[role="alert"]')?.textContent||'',/unknown/)
    await edit(' ')
    assert.match(document.querySelector('[role="alert"]')?.textContent||'',/不能为空/)
    await edit('**自定义：{event_name}**')
    assert.equal(document.querySelector('[role="alert"]'),null)
    await click('恢复默认模板');await click('取消')
    assert.equal(value,'**自定义：{event_name}**')
    await click('恢复默认模板');await click('确认')
    assert.equal(value,null)
    assert.equal(document.querySelector<HTMLTextAreaElement>('textarea')!.value,defaults)
    const variable=document.querySelector<HTMLButtonElement>('[data-template-variable="event_name"]')!
    await act(async()=>variable.click())
    assert.deepEqual(copied,['{event_name}'])
    assert.equal(value,null)
  }finally{await act(async()=>root.unmount());await window.happyDOM.close()}
})
