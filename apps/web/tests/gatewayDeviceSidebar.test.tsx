import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import GatewayDeviceSidebar from '../src/components/GatewayDeviceSidebar'
import { I18nProvider } from '../src/i18n'

test('remote device sidebar switches through a ticket and keeps offline devices disabled', async()=>{
 const {window}=installDomEnvironment();window.happyDOM.setURL('http://d-one.localhost:8700/')
 const original=globalThis.fetch;const originalSubmit=window.HTMLFormElement.prototype.submit
 let action='';let ticket='';let attempts=0
 window.HTMLFormElement.prototype.submit=function(){action=this.action;ticket=(this.querySelector('input') as HTMLInputElement).value}
 globalThis.fetch=async input=>{
  const url=String(input)
  if(url==='/api/remote/devices')return Response.json({devices:[{id:'one',name:'当前电脑',online:true},{id:'two',name:'另一电脑',online:true},{id:'off',name:'离线电脑',online:false}]})
  if(url==='/api/remote/devices/two/access')return ++attempts===1?Response.json({},{status:409}):Response.json({url:'http://d-two.localhost:8700/',ticket:'ticket'})
  throw Error(url)
 }
 const element=document.body.appendChild(document.createElement('div'));const root=createRoot(element)
 try{
  await act(async()=>root.render(<I18nProvider><GatewayDeviceSidebar currentDeviceId="one"/></I18nProvider>))
  const button=(name:string)=>Array.from(element.querySelectorAll('button')).find(b=>b.textContent?.includes(name))!
  assert.equal(button('离线电脑').disabled,true)
  assert.equal(button('当前电脑').getAttribute('aria-pressed'),'true')
  await act(async()=>button('另一电脑').click())
  assert.match(element.querySelector('[role=alert]')?.textContent??'',/离线/)
  await act(async()=>button('另一电脑').click())
  assert.equal(action,'http://d-two.localhost:8700/api/remote/redeem');assert.equal(ticket,'ticket')
  assert.equal(document.querySelector('form'),null)
 }finally{await act(async()=>root.unmount());element.remove();globalThis.fetch=original;window.HTMLFormElement.prototype.submit=originalSubmit;await window.happyDOM.close()}
})
