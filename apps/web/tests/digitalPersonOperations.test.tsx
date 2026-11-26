import {installDomEnvironment} from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {I18nProvider} from '../src/i18n'
import DigitalPersonOperations from '../src/components/digital-person/DigitalPersonOperations'
import {digitalBrowserApi} from '../src/api/digitalPersonBrowser'
import {NATIVE_CALENDAR_OPEN,useNativeCalendarStore} from '../src/stores/nativeCalendarStore'
import {nativeCalendarApi} from '../src/api/nativeCalendar'

const missing={ready:false,driver:false,browser:true,node:true,npm:true,builtin:false,version:'',status:'missing',enabled:false,installing:false,error:''}
test('operations scans on entry and installs missing component before allowing enable',async()=>{
 const {window}=installDomEnvironment();const host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const old={...digitalBrowserApi};let scans=0,downloads=0,enabled=false
 const oldTargets=nativeCalendarApi.targets
 nativeCalendarApi.targets=async()=>({owner:'operation-test',items:[]})
 digitalBrowserApi.status=async()=>{scans++;return {...missing}}
 digitalBrowserApi.install=async()=>{downloads++;return {...missing,ready:true,driver:true,version:'0.0.85'}}
 digitalBrowserApi.enable=async value=>{enabled=value;return {...missing,ready:true,driver:true,enabled:value}}
 try{
  await act(async()=>root.render(<I18nProvider><DigitalPersonOperations/></I18nProvider>))
  assert.equal(scans,1)
  let authorizationOpened=false
  window.addEventListener(NATIVE_CALENDAR_OPEN,()=>{authorizationOpened=true},{once:true})
  const calendar=host.querySelector<HTMLInputElement>('input[type=checkbox]')!
  assert.ok(Boolean(calendar),'digital hub operations owns the system sync switch')
  await act(async()=>calendar.click())
  assert.equal(authorizationOpened,true)
  assert.ok(host.querySelector('[data-install-browser]'))
  assert.ok(host.querySelector('[role=switch]') === null)
  await act(async()=>host.querySelector<HTMLButtonElement>('[data-install-browser]')!.click())
  assert.equal(downloads,1)
  assert.ok(host.querySelector('[role=switch]'))
  await act(async()=>host.querySelector<HTMLButtonElement>('[role=switch]')!.click())
  assert.equal(enabled,true)
 }finally{await act(async()=>root.unmount());await window.happyDOM.close();Object.assign(digitalBrowserApi,old);nativeCalendarApi.targets=oldTargets;useNativeCalendarStore.setState({syncEnabled:false,owner:''})}
})

test('installed operations has no download button and failed scan has retry',async()=>{
 const {window}=installDomEnvironment();const host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const old={...digitalBrowserApi};let fail=true
 digitalBrowserApi.status=async()=>{if(fail)throw new Error('scan failed');return {...missing,ready:true,driver:true}}
 try{
  await act(async()=>root.render(<I18nProvider><DigitalPersonOperations/></I18nProvider>))
  assert.match(host.textContent!,/scan failed/)
  fail=false
  await act(async()=>host.querySelector<HTMLButtonElement>('[data-scan-browser]')!.click())
  assert.ok(host.querySelector('[data-install-browser]') === null)
  assert.ok(host.querySelector('[role=switch]'))
 }finally{await act(async()=>root.unmount());await window.happyDOM.close();Object.assign(digitalBrowserApi,old)}
})


test('installation status polling failure still allows a manual rescan',async()=>{
 const {window}=installDomEnvironment();const host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const old={...digitalBrowserApi};let failed=false
 digitalBrowserApi.status=async()=>{if(failed)throw new Error('poll failed');return {...missing}}
 digitalBrowserApi.install=async()=>{failed=true;return {...missing,installing:true}}
 try{
  await act(async()=>root.render(<I18nProvider><DigitalPersonOperations/></I18nProvider>))
  await act(async()=>host.querySelector<HTMLButtonElement>('[data-install-browser]')!.click())
  assert.match(host.textContent!,/poll failed/)
  assert.equal(host.querySelector<HTMLButtonElement>('[data-scan-browser]')!.disabled,false)
 }finally{await act(async()=>root.unmount());await window.happyDOM.close();Object.assign(digitalBrowserApi,old)}
})
