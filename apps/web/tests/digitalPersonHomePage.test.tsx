import {installDomEnvironment} from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {Link,MemoryRouter,useLocation} from 'react-router-dom'
import {I18nProvider,useLocaleStore} from '../src/i18n'
import DigitalPersonHomePage,{DigitalPersonHomeRoute} from '../src/pages/DigitalPersonHomePage'
import {useProjectStore} from '../src/stores/projectStore'
import {useChatSessionStore} from '../src/stores/chatSessionStore'
import {digitalPersonApi,digitalRuntimeApi} from '../src/api/digitalPerson'
import {chatSessionApi,assistantApi,providerApi} from '../src/api/client'
import {speechOutputApi} from '../src/api/speechOutput'
import {outputStatus} from './fixtures/speechOutput'

useLocaleStore.setState({locale:'zh-CN',language:null})
import {SpeechOutputPlayer} from '../src/utils/speechOutput'
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
 const {enqueue,stop}=SpeechOutputPlayer.prototype,spoken:string[]=[]
 let mainCalls=0,historyCalls=0,stops=0
 SpeechOutputPlayer.prototype.enqueue=function(sentences){spoken.push(...sentences)}
 SpeechOutputPlayer.prototype.stop=function(){stops++;stop.call(this)}
 digitalPersonApi.get=async()=>profile
 digitalPersonApi.mainSession=async()=>{mainCalls++;return {id:'main',project_id:'home'} as any}
 digitalRuntimeApi.activity=async()=>({delegations:[],answers:[],runs:[],suggestions:[{id:'frequent-0',label:'自动推荐不应显示',prompt:'今天几号?',count:3}],feedback:{}}) as any
 chatSessionApi.quickButtons=async()=>({buttons:[{id:'manual',label:'手动快捷按钮',prompt:'请检查项目',enabled:true}]})
 chatSessionApi.get=async()=>{historyCalls++;return {id:'main',project_id:'home',title:'小研',messages:[],engine:'codex_sdk',running:false} as any}
 assistantApi.list=async()=>({assistants:[{name:'digital_person',configured:{engine:'codex_sdk'},resolved:{engine:'codex_sdk'},fields:[],available_engines:[]}]}) as any
 providerApi.list=async()=>({providers:[]})
 speechOutputApi.status=async()=>structuredClone(outputStatus)
 globalThis.fetch=async()=>Response.json({engines:[],buttons:[],runs:[],active_action_ids:[],sessions:[],preferences:{}})
 useProjectStore.setState({projects:[home],activeProject:home,loading:false})
 try{
  await act(async()=>root.render(<MemoryRouter initialEntries={['/companion']}><I18nProvider><DigitalPersonHomeRoute/><Link to="/tasks" id="tasks-link"/><Link to="/companion" id="home-link"/></I18nProvider></MemoryRouter>))
  assert.equal(mainCalls,1);assert.equal(historyCalls,1)
  assert.ok(host.querySelector('.digital-home'))
  await act(async()=>host.querySelector<HTMLButtonElement>('.digital-home-dock-transcript')!.click())
  assert.ok(!host.textContent!.includes('自动推荐不应显示'))
  const shortcut = [...host.querySelectorAll('button')].find(button=>button.textContent==='手动快捷按钮')
  assert.ok(shortcut)
  assert.equal(host.querySelector('textarea')!.value,'')
  await act(async()=>shortcut.click())
  assert.equal(host.querySelector('textarea')!.value,'请检查项目')
  await act(async()=>window.dispatchEvent(new window.Event('workstep:digital-person-changed')))
  assert.equal(mainCalls,1);assert.equal(historyCalls,1)
  await act(async()=>host.querySelector<HTMLButtonElement>('.digital-home-chat header button')!.click())
  const stream=(delta:string)=>useChatSessionStore.getState().handleWsEvent({type:'TEXT_MESSAGE_CHUNK',channel:'session_chat',session_id:'main',messageId:'streaming',delta})
  await act(async()=>stream('切页前。'))
  assert.deepEqual(spoken,['切页前。'])
  const before=stops,avatar=host.querySelector('.digital-home')!
  await act(async()=>host.querySelector<HTMLAnchorElement>('#tasks-link')!.click())
  assert.ok(avatar.closest('[hidden]'))
  await act(async()=>stream('切页后。'))
  assert.deepEqual(spoken,['切页前。','切页后。'])
  assert.equal(stops,before)
  await act(async()=>host.querySelector<HTMLAnchorElement>('#home-link')!.click())
  assert.equal(avatar.closest('[hidden]'),null)
  assert.equal(mainCalls,1);assert.equal(historyCalls,1)
  await act(async()=>host.querySelector<HTMLAnchorElement>('#tasks-link')!.click())
  await act(async()=>useProjectStore.setState({activeProject:{...home,id:'other',is_default_workspace:false}}))
  assert.equal(host.querySelector('.digital-home'),null)
  assert.ok(stops>before)
 }finally{await act(async()=>root.unmount());await window.happyDOM.close();Object.assign(digitalPersonApi,oldPerson);Object.assign(digitalRuntimeApi,oldRuntime);Object.assign(chatSessionApi,oldChat);Object.assign(SpeechOutputPlayer.prototype,{enqueue,stop});assistantApi.list=oldAssistant;providerApi.list=oldProviders;speechOutputApi.status=oldOutput;globalThis.fetch=oldFetch}
})
