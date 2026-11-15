import {installDomEnvironment} from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {MemoryRouter,useLocation} from 'react-router-dom'
import {I18nProvider} from '../src/i18n'
import DigitalPersonHomePage from '../src/pages/DigitalPersonHomePage'
import {useProjectStore} from '../src/stores/projectStore'
import {digitalPersonApi,digitalRuntimeApi} from '../src/api/digitalPerson'
import {chatSessionApi,assistantApi,providerApi} from '../src/api/client'
import {speechOutputApi} from '../src/api/speechOutput'
import {outputStatus} from './fixtures/speechOutput'
const home={id:'home',name:'默认工作区',path:'/home',is_default_workspace:true,workflows:[]}
const profile={enabled:true,name:'小研',role:'研发伙伴',personality:'直接',duties:'跟进',greeting:'你好',avatar:'robot' as const}

test('disabled digital person returns to workbench without creating a main chat',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const old={...digitalPersonApi};let calls=0,path=''
 digitalPersonApi.get=async()=>({...profile,enabled:false})
 digitalPersonApi.mainSession=async()=>{calls++;throw new Error('must not create')}
 useProjectStore.setState({projects:[home],activeProject:home})
 function Location(){const value=useLocation();path=value.pathname+value.search;return null}
 try{
  await act(async()=>root.render(<MemoryRouter initialEntries={['/companion']}><I18nProvider><DigitalPersonHomePage/><Location/></I18nProvider></MemoryRouter>))
  assert.equal(calls,0)
  assert.ok(path.startsWith('/chat?project='))
 }finally{await act(async()=>root.unmount());await window.happyDOM.close();Object.assign(digitalPersonApi,old)}
})

test('home rejects a main session belonging to a different workspace',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const old={...digitalPersonApi}
 digitalPersonApi.get=async()=>profile
 digitalPersonApi.mainSession=async()=>({id:'wrong',project_id:'other'}) as any
 useProjectStore.setState({projects:[home],activeProject:home})
 try{
  await act(async()=>root.render(<MemoryRouter><I18nProvider><DigitalPersonHomePage/></I18nProvider></MemoryRouter>))
  assert.match(host.textContent!,/工作区已变更/)
  assert.equal(host.querySelector('.digital-home'),null)
 }finally{await act(async()=>root.unmount());await window.happyDOM.close();Object.assign(digitalPersonApi,old)}
})

test('home resolves and loads the persisted main chat once using the shared chat page',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const oldPerson={...digitalPersonApi},oldRuntime={...digitalRuntimeApi},oldChat={...chatSessionApi},oldAssistant=assistantApi.list,oldProviders=providerApi.list,oldOutput=speechOutputApi.status,oldFetch=globalThis.fetch
 let mainCalls=0,historyCalls=0
 digitalPersonApi.get=async()=>profile
 digitalPersonApi.mainSession=async()=>{mainCalls++;return {id:'main',project_id:'home'} as any}
 digitalRuntimeApi.activity=async()=>({delegations:[],answers:[],runs:[],suggestions:[],feedback:{}}) as any
 chatSessionApi.get=async()=>{historyCalls++;return {id:'main',project_id:'home',title:'小研',messages:[],engine:'codex_sdk',running:false} as any}
 assistantApi.list=async()=>({assistants:[{name:'digital_person',configured:{engine:'codex_sdk'},resolved:{engine:'codex_sdk'},fields:[],available_engines:[]}]}) as any
 providerApi.list=async()=>({providers:[]})
 speechOutputApi.status=async()=>structuredClone(outputStatus)
 globalThis.fetch=async()=>Response.json({engines:[],buttons:[],runs:[],active_action_ids:[],sessions:[],preferences:{}})
 useProjectStore.setState({projects:[home],activeProject:home,loading:false})
 try{
  await act(async()=>root.render(<MemoryRouter initialEntries={['/companion']}><I18nProvider><DigitalPersonHomePage/></I18nProvider></MemoryRouter>))
  assert.equal(mainCalls,1);assert.equal(historyCalls,1)
  assert.ok(host.querySelector('.digital-home'))
  await act(async()=>window.dispatchEvent(new window.Event('workstep:digital-person-changed')))
  assert.equal(mainCalls,1);assert.equal(historyCalls,1)
 }finally{await act(async()=>root.unmount());await window.happyDOM.close();Object.assign(digitalPersonApi,oldPerson);Object.assign(digitalRuntimeApi,oldRuntime);Object.assign(chatSessionApi,oldChat);assistantApi.list=oldAssistant;providerApi.list=oldProviders;speechOutputApi.status=oldOutput;globalThis.fetch=oldFetch}
})
