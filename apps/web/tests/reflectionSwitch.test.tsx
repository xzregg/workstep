import {installDomEnvironment} from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {I18nProvider} from '../src/i18n'
import {digitalPersonApi} from '../src/api/digitalPerson'
import ReflectionSwitch from '../src/components/digital-person/ReflectionSwitch'
import {DIGITAL_PERSON_CHANGED} from '../src/components/digital-person/useDigitalPerson'

test('reflection switch uses confirmed state, handles failure and synchronizes external changes',async()=>{
 installDomEnvironment()
 const host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const get=digitalPersonApi.get,save=digitalPersonApi.save
 let enabled=true,fail=false,automaticClose=false,finish:(()=>void)|undefined
 digitalPersonApi.get=async()=>({enabled:true,reflection_enabled:enabled}) as any
 digitalPersonApi.save=async profile=>{await new Promise<void>(resolve=>{finish=resolve});if(fail)throw new Error('private request');const saved=!!profile.reflection_enabled;enabled=automaticClose?false:saved;return {...profile,reflection_enabled:saved}}
 try{
  await act(async()=>root.render(<I18nProvider><ReflectionSwitch/></I18nProvider>))
  const control=host.querySelector<HTMLButtonElement>('[role=switch]')!
  assert.equal(control.getAttribute('aria-checked'),'true')
  await act(async()=>control.click())
  assert.equal(control.disabled,true);assert.equal(control.getAttribute('aria-checked'),'true')
  await act(async()=>finish!())
  assert.equal(control.getAttribute('aria-checked'),'false')
  fail=true;await act(async()=>control.click());await act(async()=>finish!())
  assert.equal(control.getAttribute('aria-checked'),'false')
  assert.match(host.querySelector('[role=alert]')?.textContent??'',/保存失败/)
  assert.doesNotMatch(host.textContent??'',/private request/)
  fail=false;automaticClose=true;await act(async()=>control.click());await act(async()=>finish!())
  assert.equal(control.getAttribute('aria-checked'),'false','an automatic shutdown during saving wins over the earlier response')
  enabled=true;await act(async()=>window.dispatchEvent(new Event(DIGITAL_PERSON_CHANGED)))
  assert.equal(control.getAttribute('aria-checked'),'true')
 }finally{await act(async()=>root.unmount());digitalPersonApi.get=get;digitalPersonApi.save=save;host.remove()}
})
