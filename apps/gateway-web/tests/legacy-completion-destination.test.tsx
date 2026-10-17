import assert from 'node:assert/strict'
import { afterEach,test } from 'node:test'
import { JSDOM } from 'jsdom'
import { MemoryRouter,Route,Routes,useLocation } from 'react-router-dom'
import { LegacyCompletionDestinationPage } from '../src/LegacyCompletionDestinationPage'
const dom=new JSDOM('',{url:'https://gateway.test/'})
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,MutationObserver:dom.window.MutationObserver})
Object.defineProperty(globalThis,'navigator',{configurable:true,value:dom.window.navigator})
const {render,screen,waitFor,cleanup}=await import('@testing-library/react')
const oldFetch=globalThis.fetch,oldSubmit=dom.window.HTMLFormElement.prototype.submit
afterEach(()=>{cleanup();globalThis.fetch=oldFetch;dom.window.HTMLFormElement.prototype.submit=oldSubmit})
test('old APK root task URL rechecks its source and redeems into that device',async()=>{
 let action='',next=''
 dom.window.HTMLFormElement.prototype.submit=function(){action=this.action;next=new dom.window.FormData(this).get('next')?.toString() ?? ''}
 globalThis.fetch=async input=>{
  const url=new URL(String(input),'https://gateway.test')
  assert.equal(url.searchParams.get('project_id'),'gateway/device/host-project')
  assert.equal(url.searchParams.get('task_id'),'task')
  return Response.json({url:'https://gateway.test/workspace/device/',ticket:'ticket',next:'tasks?project=Demo&task=task'})
 }
 render(<MemoryRouter initialEntries={['/tasks?project=gateway%2Fdevice%2Fhost-project&task=task']}><LegacyCompletionDestinationPage/></MemoryRouter>)
 await waitFor(()=>assert.equal(action,'https://gateway.test/workspace/device/api/remote/redeem'))
 assert.equal(next,'tasks?project=Demo&task=task')
 assert.equal(document.querySelector('iframe'),null)
})
test('offline Android notification target remains retryable',async()=>{
 globalThis.fetch=async()=>new Response(null,{status:409})
 render(<MemoryRouter initialEntries={['/chat?project=gateway%2Fdevice%2Fp&session=s']}><LegacyCompletionDestinationPage/></MemoryRouter>)
 await screen.findByText('来源设备离线，上线后可重试。')
 assert.ok(screen.getByRole('button',{name:'重试'}))
})
test('workspace task link recovery keeps device, project, workflow and task through redemption',async()=>{
 let action='',next=''
 dom.window.HTMLFormElement.prototype.submit=function(){action=this.action;next=new dom.window.FormData(this).get('next')?.toString() ?? ''}
 globalThis.fetch=async input=>{
  const url=new URL(String(input),'https://gateway.test')
  assert.equal(url.searchParams.get('device_id'),'source-device')
  assert.equal(url.searchParams.get('project_id'),'workstep')
  assert.equal(url.searchParams.get('task_id'),'target-task')
  assert.equal(url.searchParams.get('workflow_id'),'e3606e86')
  return Response.json({url:'https://gateway.test/workspace/source-device/',ticket:'ticket',next:'tasks?project=workstep&workflow=e3606e86&task=target-task'})
 }
 render(<MemoryRouter initialEntries={['/tasks?device=source-device&project=workstep&workflow=e3606e86&task=target-task']}><LegacyCompletionDestinationPage/></MemoryRouter>)
 await waitFor(()=>assert.equal(action,'https://gateway.test/workspace/source-device/api/remote/redeem'))
 assert.equal(next,'tasks?project=workstep&workflow=e3606e86&task=target-task')
})
test('signed-out workspace link recovery retains the complete target after login',async()=>{
 const destination='/tasks?device=source-device&project=workstep&workflow=e3606e86&task=target-task'
 globalThis.fetch=async()=>new Response(null,{status:401})
 function Login(){const location=useLocation();return <output>{new URLSearchParams(location.search).get('next')}</output>}
 render(<MemoryRouter initialEntries={[destination]}><Routes>
  <Route path="/tasks" element={<LegacyCompletionDestinationPage/>}/><Route path="/auth" element={<Login/>}/>
 </Routes></MemoryRouter>)
 await waitFor(()=>assert.equal(document.querySelector('output')?.textContent,destination))
})
