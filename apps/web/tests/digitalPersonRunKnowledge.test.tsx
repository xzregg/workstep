import {installDomEnvironment} from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {I18nProvider,useLocaleStore} from '../src/i18n'
import DigitalPersonHomeDetails from '../src/components/digital-person/DigitalPersonHomeDetails'
import {digitalRuntimeApi} from '../src/api/digitalPerson'
import DigitalPersonRunKnowledge,{DigitalPersonRunSummary} from '../src/components/digital-person/DigitalPersonRunKnowledge'

test('one disclosure loads matching memories with the thought and keeps affinity in the list',async t=>{
 const {window}=installDomEnvironment()
 const root=createRoot(document.body.appendChild(document.createElement('div')))
 const originalLocale=useLocaleStore.getState().locale
 useLocaleStore.setState({locale:'zh-CN'})
 t.after(async()=>{await act(async()=>root.unmount());useLocaleStore.setState({locale:originalLocale});await window.happyDOM.close()})
 const calls:string[]=[]
 const outcome={sent:0,failed:0,affinity_increased:1,affinity_decreased:0}
 const run={id:'r1',created_at:'2026-11-16T01:00:00Z',summary:'',status:'silent',processing:{messages:4,sessions:2,memories:2},outcome}
 const zero={...run,id:'zero',processing:{...run.processing,memories:0},outcome:undefined}
 const old={...run,id:'old',processing:undefined,summary:'已显示的历史摘要。'}
 const failed={...old,id:'failed',status:'failed',outcome:null}
 const knowledge={status:'available',items:[{id:'knowledge:9',summary:'此次新增的知识'}],unavailable:1}
 let status=200
 t.mock.method(globalThis,'fetch',async (input:RequestInfo|URL)=>{
  const path=String(input)
  calls.push(path)
  if(path.endsWith('/r1/knowledge'))return Response.json(status===200?knowledge:{detail:'暂不可用'},{status})
  if(path.endsWith('/old/knowledge'))return Response.json({status:'legacy',items:[],unavailable:0})
  if(path.endsWith('/zero'))return Response.json({...zero,outcome,summary:'零新增的说明。'})
  if(path.endsWith('/old'))return Response.json({...old,processing:run.processing})
  return Response.json({...run,summary:'发布范围仍待确认。'})
 })
 await act(async()=>root.render(<I18nProvider><DigitalPersonHomeDetails kind="reflection" name="小研" state="idle" activity={null} affect={null} onClose={()=>{}} records={{
  checking:false,run_total:4,delegation_total:0,delegations:[],runs:[run,zero,old,failed],
 }}/></I18nProvider>))
 const rows=document.querySelectorAll('.digital-home-detail-run')
 const toggle=(index:number)=>rows[index].querySelector<HTMLButtonElement>('.digital-run-detail-toggle')!
 assert.equal(rows[0].querySelectorAll('button').length,1)
 assert.deepEqual(Array.from(rows[0].querySelector('.digital-run-knowledge')!.children,child=>child.textContent),['4条消息 · 2个会话','新增2条记忆'])
 assert.match(rows[0].querySelector('.digital-run-meta')!.textContent!,/未发通知好感度 \+1/)
 assert.ok(rows[0].querySelector('.digital-run-meta')!.lastElementChild?.matches('time'))
 assert.doesNotMatch(rows[1].textContent!,/新增.*记忆/)
 assert.deepEqual(calls,[])
 await act(async()=>rows[0].querySelector<HTMLElement>('.digital-run-knowledge')!.click())
 assert.equal(toggle(0).getAttribute('aria-expanded'),'true')
 const detail=rows[0].querySelector('.digital-person-run-detail')!
 assert.match(detail.textContent!,/发布范围仍待确认。/)
 assert.match(detail.textContent!,/此次新增的知识/)
 assert.match(detail.textContent!,/1 条记忆已不可查看/)
 assert.doesNotMatch(detail.textContent!,/4条消息|2个会话|未发通知|好感度/)
 assert.deepEqual(calls.sort(),['/api/digital-person/runs/r1','/api/digital-person/runs/r1/knowledge'])
 await act(async()=>rows[0].querySelector<HTMLElement>('time')!.click())
 assert.equal(rows[0].querySelector('.digital-person-run-detail'),null)
 status=403
 await act(async()=>toggle(0).click())
 assert.match(rows[0].querySelector('[role="alert"]')!.textContent!,/没有权限/)
 await act(async()=>toggle(0).click())
 status=503
 await act(async()=>toggle(0).click())
 const retry=rows[0].querySelector<HTMLButtonElement>('.digital-run-knowledge-preview button')!
 assert.equal(retry.textContent,'重试')
 status=200
 await act(async()=>retry.click())
 assert.match(rows[0].textContent!,/此次新增的知识/)
 await act(async()=>toggle(1).click())
 assert.match(rows[1].querySelector('.digital-person-run-detail')!.textContent!,/好感度 \+1/)
 assert.equal(calls.includes('/api/digital-person/runs/zero/knowledge'),false)
 await act(async()=>toggle(2).click())
 assert.match(rows[2].querySelector('.digital-person-run-detail')!.textContent!,/历史记录未保存知识关联/)
 assert.equal(rows[2].textContent!.match(/已显示的历史摘要。/g)?.length,1)
 assert.equal(rows[3].textContent!.match(/未完成/g)?.length,1)
 assert.ok(rows[3].querySelector('time')?.textContent)
})

test('older source-only summaries drop a dangling separator',async t=>{
 const {window}=installDomEnvironment()
 t.after(async()=>window.happyDOM.close())
 t.mock.method(globalThis,'fetch',async()=>Response.json({
  runs:[{id:'old',status:'silent',summary:'整理 4 条消息（2 个会话），'}],
  run_total:1,delegations:[],delegation_total:0,checking:false,
 }))
 const {runs}=await digitalRuntimeApi.records()
 assert.deepEqual(runs[0].processing,{messages:4,sessions:2,memories:0})
 assert.equal(runs[0].summary,'')
})

test('reflection shows committed changes by kind and labels updated preferences separately',async t=>{
 const {window}=installDomEnvironment()
 const root=createRoot(document.body.appendChild(document.createElement('div')))
 const originalLocale=useLocaleStore.getState().locale
 useLocaleStore.setState({locale:'zh-CN'})
 t.after(async()=>{await act(async()=>root.unmount());useLocaleStore.setState({locale:originalLocale});await window.happyDOM.close()})
 t.mock.method(globalThis,'fetch',async()=>Response.json({status:'available',unavailable:0,items:[
  {id:'knowledge:1',summary:'日常简短，技术分析详细。',kind:'preference',operation:'updated'},
  {id:'knowledge:2',summary:'用户今天确认了交付。',kind:'event',operation:'added'},
 ]}))
 await act(async()=>root.render(<I18nProvider>
  <DigitalPersonRunSummary processing={{messages:6,sessions:2,memories:5,changes:{added:{event:2,fact:1,experience:1},updated:{preference:1}}}}>
   {summary=><div data-summary>{summary}</div>}
  </DigitalPersonRunSummary>
  <DigitalPersonRunKnowledge runId="typed"/>
 </I18nProvider>))
 const summary=document.querySelector('[data-summary]')!.textContent!
 for(const text of ['6条消息 · 2个会话','新增2条事件','新增1条事实','新增1条经验','更新1条偏好'])assert.ok(summary.includes(text),summary)
 assert.doesNotMatch(summary,/新增5条记忆|新增\d+条偏好|删除|0条/)
 const items=document.querySelectorAll('.digital-run-knowledge-preview li')
 assert.match(items[0].textContent!,/更新.*偏好.*日常简短，技术分析详细/)
 assert.match(items[1].textContent!,/新增.*事件.*用户今天确认了交付/)
})
