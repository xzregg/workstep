import {installDomEnvironment} from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {MemoryRouter} from 'react-router-dom'
import {I18nProvider,useLocaleStore} from '../src/i18n'
import DigitalPersonHomeInsights from '../src/components/digital-person/DigitalPersonHomeInsights'
import {digitalRuntimeApi,type DigitalActivityRecords} from '../src/api/digitalPerson'
import {DIGITAL_ACTIVITY_CHANGED} from '../src/components/digital-person/useDigitalActivity'
import {useProjectStore} from '../src/stores/projectStore'
import {useChatSessionStore} from '../src/stores/chatSessionStore'
import {useLocation} from 'react-router-dom'
import {taskApi} from '../src/api/client'

test('workflow delegation opens its actual task instead of an execution chat',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const original=digitalRuntimeApi.records,originalGet=taskApi.get,originalProjects=useProjectStore.getState()
 const project={id:'target',name:'开发项目',path:'/target',workflows:[{id:'flow',name:'开发流程'}]}
 useProjectStore.setState({projects:[project] as any})
 let route='',calls=0
 function Location(){const location=useLocation();route=location.pathname+location.search;return null}
 digitalRuntimeApi.records=async()=>({checking:false,run_total:0,delegation_total:1,runs:[],delegations:[{
  id:'d',kind:'workflow_task',project_id:'target',session_id:'',task_id:'real-task',workflow_id:'flow',
  instruction:'开发登录',title:'实现登录',status:'waiting',status_reason:'manual_review',
 }]})
 taskApi.get=async(id,pid)=>{calls++;assert.equal(id,'real-task');assert.equal(pid,'target');return {id,workflow_id:'flow'} as any}
 try{
  await act(async()=>root.render(<MemoryRouter initialEntries={['/companion']}><I18nProvider><Location/><DigitalPersonHomeInsights active name="小研" state="idle" activity={null} affect={null} chatShown={false} onInspect={()=>{}}/></I18nProvider></MemoryRouter>))
  const row=host.querySelector<HTMLButtonElement>('.digital-home-work-summary')!
  assert.equal(row.dataset.status,'waiting')
  assert.equal(Boolean(row.querySelector('.task-status-spinner')),false)
  assert.equal(calls,0)
  await act(async()=>row.click())
  const url=new URL(route,'http://test')
  assert.equal(url.pathname,'/tasks');assert.equal(url.searchParams.get('task'),'real-task')
  assert.equal(url.searchParams.get('workflow'),'flow');assert.equal(url.searchParams.get('project'),'开发项目')
  assert.equal(Boolean(document.querySelector('.digital-person-conversation-frame')),false)
  assert.equal(calls,1)
 }finally{await act(async()=>root.unmount());digitalRuntimeApi.records=original;taskApi.get=originalGet;useProjectStore.setState(originalProjects);await window.happyDOM.close()}
})

test('delegation opens its execution conversation in a dialog without changing the current project or route',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const original=digitalRuntimeApi.records,originalFetch=globalThis.fetch
 const home={id:'home',name:'主工作区',path:'/home',workflows:[]},target={id:'target',name:'执行项目',path:'/target',workflows:[]}
 useProjectStore.setState({projects:[home,target] as any,activeProject:home as any})
 useChatSessionStore.setState({sessions:{}})
 let route='',inspected=0,finishReceipt=()=>{};const requests:string[]=[],receipts:unknown[]=[]
 Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});document.hasFocus=()=>true
 function Location(){route=useLocation().pathname+useLocation().search;return null}
 digitalRuntimeApi.records=async()=>({checking:false,run_total:0,delegation_total:2,runs:[],delegations:[{id:'d',project_id:'target',session_id:'execution',title:'核对执行结果',instruction:'检查委派执行内容',status:'running',message_id:'result',result_viewed:null},{id:'missing',project_id:'deleted',session_id:'unknown',instruction:'项目已移除的委派',status:'completed'}]})
 globalThis.fetch=async(input,options)=>{
  const url=String(input);requests.push(url)
  if(url.includes('/chat-sessions/execution/read')){receipts.push(JSON.parse(String(options?.body)));return new Promise<Response>(resolve=>{finishReceipt=()=>resolve(Response.json({read:true}))})}
  if(/chat-sessions\/execution(?:\?|$)/.test(url))return Response.json({id:'execution',project_id:'target',title:'委派执行对话',engine:'pydantic_ai',messages:[{id:'m',role:'user',content:'这是对应委派的真实对话'},{id:'result',role:'assistant',status:'running',content:'正在检查'}],running:true})
  if(url.includes('/assistants'))return Response.json({assistants:[{name:'chat_session',configured:{},available_engines:[]}]})
  return Response.json({providers:[],buttons:[],runs:[],active_action_ids:[],sessions:[]})
 }
 try{
  await act(async()=>root.render(<MemoryRouter initialEntries={['/digital-person']}><I18nProvider><Location/><DigitalPersonHomeInsights active name="小研" state="idle" activity={null} affect={null} chatShown={false} onInspect={()=>inspected++}/></I18nProvider></MemoryRouter>))
  const entry=host.querySelector<HTMLButtonElement>('.digital-home-work-summary')!
  assert.equal(entry.tagName,'BUTTON');assert.equal(requests.length,0,'execution history is only loaded on click')
  assert.equal(entry.title,'核对执行结果')
  assert.match(entry.textContent!,/核对执行结果/)
  assert.doesNotMatch(entry.textContent!,/检查委派执行内容/)
  assert.match(host.textContent!,/项目已移除的委派/)
  entry.focus();await act(async()=>entry.click())
  for(let i=0;i<200&&!document.querySelector('.digital-person-delegation-content textarea');i++)await act(async()=>{await new Promise(resolve=>setTimeout(resolve,25))})
  const dialog=document.querySelector<HTMLElement>('.digital-person-inline-conversation .digital-person-conversation-frame')!
  assert.ok(dialog);assert.match(dialog.textContent!,/这是对应委派的真实对话/);assert.ok(dialog.querySelector('textarea'))
  assert.equal(dialog.querySelector('header h2')?.textContent,'核对执行结果')
  assert.equal(dialog.querySelector('.digital-person-delegation-project')?.textContent,'执行项目')
  assert.ok(dialog.querySelector('.assistant-chat-header') === null, 'the dialog supplies the only conversation header')
  assert.equal(route,'/digital-person');assert.equal(useProjectStore.getState().activeProject?.id,'home');assert.equal(inspected,1)
  assert.ok(requests.some(url=>url.includes('/chat-sessions/execution?')&&url.includes('project_id=target')))
  assert.equal(dialog.querySelectorAll('.resizable-panel-handle').length,8)
  assert.deepEqual(receipts,[]);assert.match(entry.textContent!,/执行中/);assert.doesNotMatch(entry.textContent!,/查看|通知/)
  await act(async()=>useChatSessionStore.setState(({sessions})=>({sessions:{...sessions,execution:{...sessions.execution,running:false,messages:sessions.execution.messages.map(message=>message.id==='result'?{...message,status:'succeeded',content:'委派结果已生成'}:message)}}})))
  assert.match(dialog.textContent!,/委派结果已生成/)
  assert.deepEqual(receipts,[{message_id:'result'}]);assert.match(entry.textContent!,/已完成已查看/,'the displayed result updates the list before the server responds')
  await act(async()=>finishReceipt())
  await act(async()=>document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})))
  assert.ok(document.querySelector('.digital-person-inline-conversation .digital-person-conversation-frame') === null);assert.ok(document.activeElement === entry)
  await act(async()=>host.querySelectorAll<HTMLButtonElement>('.digital-home-work-summary')[1].click())
  assert.match(document.querySelector('[role="alert"]')!.textContent!,/该项目尚未加载/)
  assert.equal(requests.some(url=>url.includes('unknown')),false)
  await act(async()=>document.querySelector<HTMLButtonElement>('.digital-person-delegation-close')!.click())
  assert.ok(document.querySelector('.digital-person-inline-conversation .digital-person-conversation-frame') === null)
 }finally{await act(async()=>root.unmount());digitalRuntimeApi.records=original;globalThis.fetch=originalFetch;await window.happyDOM.close()}
})
test('home records coalesce refreshes and do not poll hidden or inactive views',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host),original=digitalRuntimeApi.records
 let calls=0,resolve:(data:DigitalActivityRecords)=>void=()=>{}
 const intervals:number[]=[]
 const originalInterval=window.setInterval.bind(window)
 window.setInterval=((handler:TimerHandler, delay?:number)=>{intervals.push(delay??0);return originalInterval(handler,delay)}) as typeof window.setInterval
 digitalRuntimeApi.records=()=>{calls++;return new Promise(done=>{resolve=done})}
 const render=(active:boolean)=>root.render(<I18nProvider><DigitalPersonHomeInsights active={active} name="小研" state="idle" activity={null} affect={null} chatShown={false} onInspect={()=>{}}/></I18nProvider>)
 try{
  await act(async()=>render(true));assert.equal(calls,1)
  assert.ok(intervals.every(delay=>delay>=30000),'stale running rows must not schedule a fast records poll')
  assert.match(host.querySelector('.digital-home-affinity')!.textContent!,/—/)
  await act(async()=>{window.dispatchEvent(new window.Event(DIGITAL_ACTIVITY_CHANGED));window.dispatchEvent(new window.Event(DIGITAL_ACTIVITY_CHANGED))});assert.equal(calls,1)
  await act(async()=>resolve({checking:false,reflection_count:777,reflection_count_lower_bound:true,run_total:48,delegation_total:0,runs:[],delegations:[]}))
  assert.match(host.querySelector('[aria-label="主动思考"]')?.textContent??'',/777\+/)
  Object.defineProperty(document,'hidden',{configurable:true,value:true})
  await act(async()=>window.dispatchEvent(new window.Event(DIGITAL_ACTIVITY_CHANGED)));assert.equal(calls,1)
  await act(async()=>render(false));Object.defineProperty(document,'hidden',{configurable:true,value:false})
  await act(async()=>window.dispatchEvent(new window.Event(DIGITAL_ACTIVITY_CHANGED)));assert.equal(calls,1)
 }finally{await act(async()=>root.unmount());digitalRuntimeApi.records=original;await window.happyDOM.close()}
})


test('corner actions open their own information panel instead of settings',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host),original=digitalRuntimeApi.records
 const originalLocale=useLocaleStore.getState().locale
 useLocaleStore.setState({locale:'zh-CN'})
 let settings=0;window.addEventListener('workstep:open-digital-person-settings',()=>settings++)
 digitalRuntimeApi.records=async()=>({checking:false,run_total:1,delegation_total:0,runs:[{id:'r1',summary:'今天的思考记录',status:'completed',created_at:'2026-11-16T01:00:00Z'}],delegations:[]})
 try{
  await act(async()=>root.render(<MemoryRouter><I18nProvider><DigitalPersonHomeInsights active canControlWake name="小研" state="idle" activity={{level:3,experience:20,next_level_experience:100} as any} affect={{name:'会话作者',person_id:'p',affinity:68,emotion:'calm',valence:0,arousal:0,updated_at:null,history:[]}} chatShown={false} onInspect={()=>{}}/></I18nProvider></MemoryRouter>))
  const identity=host.querySelector<HTMLButtonElement>('.digital-home-identity')!;identity.focus()
  await act(async()=>identity.click());assert.match(document.querySelector('[role="dialog"]')!.textContent!,/小研/)
  assert.match(document.querySelector('[role="dialog"]')!.textContent!,/Lv.3/)
  const switches=document.querySelector('[role="dialog"]')!.querySelectorAll<HTMLButtonElement>('[role="switch"]')
  assert.equal(switches.length,1)
  assert.equal(switches[0].getAttribute('aria-label'),'语音唤醒')
  assert.ok(document.querySelector('[role="dialog"] input') === null)
  await act(async()=>switches[0].click())
  assert.equal(switches[0].getAttribute('aria-checked'),'true')
  assert.equal(localStorage.getItem('workstep.digital-person.wake-enabled'),'true')
  await act(async()=>document.querySelector<HTMLButtonElement>('.digital-home-detail-close')!.click());assert.ok(document.activeElement === identity)
  await act(async()=>host.querySelector<HTMLButtonElement>('.digital-home-affinity')!.click());assert.match(document.querySelector('[role="dialog"]')!.textContent!,/68/)
  assert.ok(document.querySelector('[role="dialog"] [role="switch"]') === null)
  await act(async()=>document.querySelector<HTMLButtonElement>('.digital-home-detail-close')!.click())
  const reflection=host.querySelector<HTMLButtonElement>('[aria-label="主动思考"]')!
  reflection.focus()
  await act(async()=>reflection.click())
  const history=document.querySelector('.digital-home-detail-panel--reflection')!
  assert.match(history.textContent!,/今天的思考记录/)
  assert.ok(history.querySelector('footer .digital-home-detail-pages'))
  await act(async()=>history.querySelector<HTMLButtonElement>('.digital-home-detail-close')!.click())
  assert.ok(document.activeElement === reflection)
  assert.equal(settings,0)
 }finally{await act(async()=>root.unmount());useLocaleStore.setState({locale:originalLocale});digitalRuntimeApi.records=original;await window.happyDOM.close()}
})


test('activity shows only the delegation timeline, ordered by local date and time',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host),original=digitalRuntimeApi.records
 const originalLocale=useLocaleStore.getState().locale
 useLocaleStore.setState({locale:'zh-CN'})
 const record=(id:string,instruction:string,status:string,created_at?:string,result_viewed?:boolean)=>({id,instruction,status,created_at,result_viewed,project_id:'p',session_id:'s'})
 digitalRuntimeApi.records=async()=>({checking:false,run_total:1,delegation_total:5,runs:[{id:'r1',summary:'复盘今日安排',status:'silent',created_at:'2026-11-17T01:00:00Z'}],delegations:[
  record('old','核对旧任务','completed','2026-11-16T20:01:00',true),
  record('next','整理工作安排','running','2026-11-17T19:44:00'),
  {...record('legacy','历史委派','completed'),archived:true},
  record('done','检查构建结果','completed','2026-11-17T17:26:00',false),
  record('failed','修复识别问题','failed','2026-11-17T10:05:00',true),
 ]})
 try{
  await act(async()=>root.render(<I18nProvider><DigitalPersonHomeInsights active name="小研" state="idle" activity={null} affect={null} chatShown={false} onInspect={()=>{}}/></I18nProvider>))
  const context=host.querySelector('.digital-home-context')!
  assert.equal(context.querySelector('h2')!.textContent,'动态')
  assert.doesNotMatch(context.textContent!,/主动思考|复盘今日安排/)
  const days=Array.from(context.querySelectorAll('.digital-home-work ol'))
  assert.deepEqual(days.map(day=>day.children.length),[3,1,1])
  assert.deepEqual(Array.from(context.querySelectorAll('.digital-home-work time'),time=>time.textContent),['19:44','17:26','10:05','20:01'])
  const rows=Array.from(context.querySelectorAll<HTMLButtonElement>('.digital-home-work-summary'))
  assert.deepEqual(rows.map(row=>row.querySelector('strong')?.textContent),['整理工作安排','检查构建结果','修复识别问题','核对旧任务','历史委派'])
  assert.ok(rows[0].querySelector('.task-status-spinner'))
  assert.match(rows[1].textContent!,/已完成.*未查看/)
  assert.match(rows[2].textContent!,/失败.*已查看/)
  assert.match(days[2].parentElement!.textContent!,/日期未知/)
  assert.match(rows[4].textContent!,/已归档/)
  assert.equal(rows[4].dataset.status,'archived')
  assert.equal(rows[4].disabled,false)
 }finally{await act(async()=>root.unmount());useLocaleStore.setState({locale:originalLocale});digitalRuntimeApi.records=original;await window.happyDOM.close()}
})

test('delegation paging coalesces requests and keeps loaded history after refresh',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host),original=digitalRuntimeApi.records
 const originalLocale=useLocaleStore.getState().locale
 useLocaleStore.setState({locale:'zh-CN'})
 const calls:number[][]=[]
 let resolve:((data:DigitalActivityRecords)=>void)|undefined
 const page=(offset:number):DigitalActivityRecords=>({checking:false,run_total:12,delegation_total:12,runs:[],delegations:Array.from({length:5},(_,i)=>({id:`d${offset+i}`,status:'completed',instruction:`委派${offset+i}`,project_id:'p',session_id:'s'}))})
 digitalRuntimeApi.records=async(r=0,d=0)=>{calls.push([r,d]);if(!d)return page(0);return new Promise(done=>{resolve=done})}
 try{
  await act(async()=>root.render(<I18nProvider><DigitalPersonHomeInsights active name="小研" state="idle" activity={null} affect={null} chatShown={false} onInspect={()=>{}}/></I18nProvider>))
  const tasks=host.querySelector<HTMLElement>('[data-activity-scroll="delegations"]')!
  assert.deepEqual(calls,[[0,0]])
  assert.equal(tasks.querySelectorAll('.digital-home-work-summary').length,5)
  assert.ok(tasks.querySelector('.digital-home-work-next') === null, 'desktop paging has no load-older button')
  await act(async()=>{tasks.dispatchEvent(new window.Event('scroll'));tasks.dispatchEvent(new window.Event('scroll'))})
  assert.deepEqual(calls,[[0,0],[0,5]])
  await act(async()=>resolve!(page(5)))
  assert.equal(tasks.querySelectorAll('.digital-home-work-summary').length,10)
  digitalRuntimeApi.records=async(r=0,d=0)=>{
   calls.push([r,d])
   const head=page(0)
   return {...head,delegations:[{...head.delegations[0],id:'new-work'},...head.delegations.slice(0,4)]}
  }
  await act(async()=>window.dispatchEvent(new window.Event(DIGITAL_ACTIVITY_CHANGED)))
  assert.deepEqual(calls,[[0,0],[0,5],[0,0]])
  assert.equal(tasks.querySelectorAll('.digital-home-work-summary').length,11)
  assert.match(tasks.textContent!,/委派4/)
 }finally{await act(async()=>root.unmount());useLocaleStore.setState({locale:originalLocale});digitalRuntimeApi.records=original;await window.happyDOM.close()}
})

test('mobile activity drawer reuses records and paging, closes on Escape, backdrop and Back, and restores focus',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host),original=digitalRuntimeApi.records
 Object.assign(globalThis,{history:window.history})
 window.matchMedia=(()=>({matches:true,addEventListener(){},removeEventListener(){}})) as any
 const calls:number[][]=[];let inspected=0
 const data=(r=0,d=0):DigitalActivityRecords=>({checking:false,run_total:10,delegation_total:10,runs:Array.from({length:5},(_,i)=>({id:`r${r+i}`,summary:`真实思考${r+i}`,status:'completed',created_at:'2026-11-17T01:00:00Z'})),delegations:Array.from({length:5},(_,i)=>({id:`d${d+i}`,instruction:`真实委派${d+i}`,status:'completed',notification_state:'notified',result_viewed:false,project_id:'p',session_id:'s'}))})
 digitalRuntimeApi.records=async(r=0,d=0)=>{calls.push([r,d]);return data(r,d)}
 const render=(chatShown=false)=>root.render(<I18nProvider><DigitalPersonHomeInsights active name="小研" state="idle" activity={null} affect={null} chatShown={chatShown} onInspect={()=>{inspected++}}/></I18nProvider>)
 try{
  await act(async()=>render())
  const entry=host.querySelector<HTMLButtonElement>('.digital-home-activity-entry')!
  assert.ok(entry);assert.equal(entry.textContent,'动态');assert.ok(document.querySelector('.digital-home-activity-dialog') === null)
  entry.focus();await act(async()=>entry.click())
  let dialog=document.querySelector<HTMLElement>('.digital-home-activity-dialog')!
  assert.ok(dialog);assert.equal(dialog.getAttribute('aria-modal'),'true');assert.equal(dialog.getAttribute('aria-label'),'动态');assert.equal(dialog.querySelector('h2')!.textContent,'动态');assert.equal(inspected,1)
  assert.doesNotMatch(dialog.textContent!,/主动思考|真实思考0/);assert.match(dialog.textContent!,/真实委派0/);assert.equal(dialog.querySelectorAll('.digital-home-work-viewed[data-viewed="false"]').length,5);assert.doesNotMatch(dialog.textContent!,/已通知/)
  assert.deepEqual(calls,[[0,0]],'opening uses existing records without another request')
  const task=dialog.querySelector<HTMLButtonElement>('.digital-home-work-summary')!
  task.focus();await act(async()=>task.click())
  assert.ok(document.querySelector('.digital-person-inline-conversation .digital-person-conversation-frame'))
  assert.equal(document.querySelector<HTMLElement>('.digital-home-activity-backdrop')?.hidden,true)
  await act(async()=>{window.history.back();await new Promise(resolve=>setTimeout(resolve,20))})
  assert.ok(document.querySelector('.digital-person-inline-conversation .digital-person-conversation-frame') === null)
  assert.ok(document.querySelector('.digital-home-activity-dialog') === dialog, 'Back returns to the same list')
  assert.ok(document.activeElement === task)
  assert.equal(document.body.style.overflow,'hidden');assert.ok(dialog.contains(document.activeElement))
  dialog.querySelector<HTMLButtonElement>('.digital-home-activity-close')!.focus()
  await act(async()=>document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Tab',shiftKey:true,bubbles:true})))
  assert.ok(document.activeElement === dialog.querySelector('.digital-home-work-next'))
  await act(async()=>document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Tab',bubbles:true})))
  assert.ok(document.activeElement === dialog.querySelector('.digital-home-activity-close'))
  await act(async()=>dialog.querySelector('[data-activity-scroll="delegations"]')!.dispatchEvent(new window.Event('scroll')))
  assert.deepEqual(calls,[[0,0],[0,5]])
  await act(async()=>{document.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await new Promise(resolve=>setTimeout(resolve,20))})
  assert.ok(document.querySelector('.digital-home-activity-dialog') === null);assert.ok(document.activeElement === entry);assert.equal(document.body.style.overflow,'')
  await act(async()=>entry.click());await act(async()=>{document.querySelector<HTMLDivElement>('.digital-home-activity-backdrop')!.click();await new Promise(resolve=>setTimeout(resolve,20))})
  assert.ok(document.querySelector('.digital-home-activity-dialog') === null)
  await act(async()=>entry.click());await act(async()=>{window.history.back();await new Promise(resolve=>setTimeout(resolve,20))})
  assert.ok(document.querySelector('.digital-home-activity-dialog') === null)
  await act(async()=>entry.click());await act(async()=>document.querySelector<HTMLButtonElement>('.digital-home-activity-close')!.click())
  assert.equal(entry.getAttribute('aria-expanded'),'false')
  await act(async()=>entry.click());await act(async()=>render(true))
  assert.ok(document.querySelector('.digital-home-activity-dialog') === null)
  assert.ok(host.querySelector('.digital-home-activity-entry') === null)
  await act(async()=>render())
  assert.equal(host.querySelector('.digital-home-activity-entry')?.getAttribute('aria-expanded'),'false')
 }finally{await act(async()=>root.unmount());digitalRuntimeApi.records=original;await window.happyDOM.close()}
})

test('desktop expanded conversation keeps real activity visible and pageable beneath the orb',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host),original=digitalRuntimeApi.records
 window.matchMedia=(()=>({matches:false,addEventListener(){},removeEventListener(){}})) as any
 const calls:number[][]=[]
 digitalRuntimeApi.records=async(r=0,d=0)=>{calls.push([r,d]);return {checking:false,run_total:0,delegation_total:10,runs:[],delegations:Array.from({length:5},(_,i)=>({id:`expanded-${d+i}`,status:'completed',instruction:`展开时的委派${d+i}`,project_id:'p',session_id:'s'}))}}
 try{
  await act(async()=>root.render(<I18nProvider><DigitalPersonHomeInsights active name="小研" state="idle" activity={null} affect={null} chatShown onInspect={()=>{}}/></I18nProvider>))
  const context=host.querySelector<HTMLElement>('.digital-home-context')!
  assert.equal(context.hidden,false,'expanded desktop conversation retains activity')
  assert.match(context.textContent!,/展开时的委派0/)
  assert.deepEqual(calls,[[0,0]])
  await act(async()=>context.querySelector('[data-activity-scroll="delegations"]')!.dispatchEvent(new window.Event('scroll')))
  assert.deepEqual(calls,[[0,0],[0,5]],'expanded activity continues paging through the same request owner')
  assert.equal(context.querySelectorAll('.digital-home-work-summary').length,10)
 }finally{await act(async()=>root.unmount());digitalRuntimeApi.records=original;await window.happyDOM.close()}
})
