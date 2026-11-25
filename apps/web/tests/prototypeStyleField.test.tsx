import {installDomEnvironment} from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {I18nProvider} from '../src/i18n'
import PrototypeStyleField from '../src/components/prototype/PrototypeStyleField'

test('numeric property slider and text stay synchronized and save once per gesture', async()=>{
  const {window}=installDomEnvironment()
  const previews:string[]=[],commits:string[]=[]
  const root=createRoot(document.body.appendChild(document.createElement('div')))
  const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!
  const input=async(element:HTMLInputElement,value:string)=>act(async()=>{setter.call(element,value);element.dispatchEvent(new window.Event('input',{bubbles:true}))})
  try{
    await act(async()=>root.render(<I18nProvider><PrototypeStyleField property="border-radius" value="10px" disabled={false} onPreview={value=>previews.push(value)} onCommit={value=>commits.push(value)} onResetPreview={()=>{}}/></I18nProvider>))
    const text=document.querySelector<HTMLInputElement>('input[aria-label="border-radius"]')!
    const slider=document.querySelector<HTMLInputElement>('input[type="range"]')!
    assert.equal(slider.value,'10')
    await input(slider,'24')
    assert.equal(text.value,'24px')
    assert.equal(previews.at(-1),'24px')
    assert.deepEqual(commits,[])
    await act(async()=>slider.dispatchEvent(new window.PointerEvent('pointerup',{bubbles:true})))
    await act(async()=>slider.dispatchEvent(new window.FocusEvent('focusout',{bubbles:true})))
    assert.deepEqual(commits,['24px'])
    await input(text,'32px')
    assert.equal(slider.value,'32')
    await act(async()=>text.dispatchEvent(new window.FocusEvent('focusout',{bubbles:true,relatedTarget:slider})))
    assert.deepEqual(commits,['24px'],'moving focus to the paired slider keeps editing active')
    await input(slider,'40')
    await act(async()=>slider.dispatchEvent(new window.KeyboardEvent('keyup',{bubbles:true,key:'ArrowRight'})))
    assert.deepEqual(commits,['24px','40px'])
    await input(text,'')
    assert.equal(text.value,'','clearing a field is not converted to zero')
    assert.equal(slider.disabled,true)
    await act(async()=>text.dispatchEvent(new window.FocusEvent('focusout',{bubbles:true})))
    assert.deepEqual(commits,['24px','40px'])
    await act(async()=>root.render(<I18nProvider><PrototypeStyleField key="spacing" property="padding" value="8px 16px" disabled={false} onPreview={()=>{}} onCommit={()=>{}} onResetPreview={()=>{}}/></I18nProvider>))
    assert.ok(document.querySelector('input[type="range"]') === null, 'multi-value spacing remains a text field')
    await act(async()=>root.render(<I18nProvider><PrototypeStyleField key="percent" property="width" value="50%" disabled={false} onPreview={()=>{}} onCommit={()=>{}} onResetPreview={()=>{}}/></I18nProvider>))
    await input(document.querySelector<HTMLInputElement>('input[type="range"]')!,'75')
    assert.equal(document.querySelector<HTMLInputElement>('input[aria-label="width"]')!.value,'75%')
    await act(async()=>root.render(<I18nProvider><PrototypeStyleField key="margin" property="margin" value="-16px" disabled={false} onPreview={()=>{}} onCommit={()=>{}} onResetPreview={()=>{}}/></I18nProvider>))
    await input(document.querySelector<HTMLInputElement>('input[aria-label="margin"]')!,'-240px')
    assert.equal(document.querySelector<HTMLInputElement>('input[type="range"]')!.value,'-240')

  }finally{await act(async()=>root.unmount());await window.happyDOM.close()}
})
