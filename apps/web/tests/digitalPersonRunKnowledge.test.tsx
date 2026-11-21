import {installDomEnvironment} from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {I18nProvider,useLocaleStore} from '../src/i18n'
import DigitalPersonHomeDetails from '../src/components/digital-person/DigitalPersonHomeDetails'

test('memory count opens its own inline preview, refreshes on reopening, and is omitted at zero',async t=>{
 const {window}=installDomEnvironment()
 const root=createRoot(document.body.appendChild(document.createElement('div')))
 const originalLocale=useLocaleStore.getState().locale
 useLocaleStore.setState({locale:'zh-CN'})
 t.after(async()=>{await act(async()=>root.unmount());useLocaleStore.setState({locale:originalLocale});await window.happyDOM.close()})
 const calls:string[]=[]
 let status=200
 let current:unknown={status:'available',items:[{id:'knowledge:9',summary:'此次新增的知识'}],unavailable:1}
 t.mock.method(globalThis,'fetch',async (input:RequestInfo|URL)=>{
  calls.push(String(input))
  return Response.json(current,{status})
 })
 const run={id:'r1',created_at:'2026-11-16T01:00:00Z',summary:'',status:'silent',processing:{messages:4,sessions:2,memories:2}}
 await act(async()=>root.render(<I18nProvider><DigitalPersonHomeDetails kind="reflection" name="小研" state="idle" activity={null} affect={null} onClose={()=>{}} records={{
  checking:false,run_total:3,delegation_total:0,delegations:[],runs:[run,{...run,id:'zero',processing:{...run.processing,memories:0}},{...run,id:'old'}],
 }}/></I18nProvider>))
 const rows=document.querySelectorAll('.digital-home-detail-run')
 const count=rows[0].querySelector<HTMLButtonElement>('button.digital-run-knowledge-toggle')!
 assert.equal(count.textContent,'新增 2 条记忆')
 assert.equal(count.closest('.digital-home-detail-run-summary')?.textContent,'整理 4 条消息（2 个会话），新增 2 条记忆')
 assert.equal(count.parentElement?.closest('button'),null)
 assert.equal(document.getElementById(count.getAttribute('aria-controls')!)?.hidden,true)
 assert.equal(rows[1].querySelector('button.digital-run-knowledge-toggle'),null)
 assert.equal(rows[1].querySelector('.digital-home-detail-run-summary')?.textContent,'整理 4 条消息（2 个会话）')
 assert.deepEqual(calls,[])
 await act(async()=>count.click())
 assert.equal(count.getAttribute('aria-expanded'),'true')
 assert.match(rows[0].textContent!,/此次新增的知识/)
 assert.match(rows[0].textContent!,/1 条记忆已不可查看/)
 assert.deepEqual(calls,['/api/digital-person/runs/r1/knowledge'])
 assert.equal(rows[0].querySelector('.digital-person-run-detail'),null)
 await act(async()=>count.click())
 current={status:'available',items:[],unavailable:2}
 await act(async()=>count.click())
 assert.doesNotMatch(rows[0].textContent!,/此次新增的知识/)
 assert.match(rows[0].textContent!,/2 条记忆已不可查看/)
 current={status:'legacy',items:[],unavailable:0}
 await act(async()=>rows[2].querySelector<HTMLButtonElement>('button.digital-run-knowledge-toggle')!.click())
 assert.match(rows[2].textContent!,/历史记录未保存知识关联/)
 await act(async()=>count.click())
 status=403
 current={detail:'Project scope denied'}
 await act(async()=>count.click())
 assert.match(rows[0].querySelector('[role="alert"]')!.textContent!,/没有权限/)
 await act(async()=>count.click())
 status=503
 await act(async()=>count.click())
 const retry=rows[0].querySelector<HTMLButtonElement>('.digital-run-knowledge-preview button')!
 assert.equal(retry.textContent,'重试')
 status=200
 current={status:'available',items:[{id:'knowledge:11',summary:'重试后读取的知识'}],unavailable:0}
 await act(async()=>retry.click())
 assert.match(rows[0].textContent!,/重试后读取的知识/)
 current=run
 await act(async()=>rows[0].querySelector<HTMLButtonElement>('.digital-run-detail-toggle')!.click())
 assert.equal(rows[0].querySelector('.digital-person-run-summary p')?.textContent,'整理 4 条消息（2 个会话）')
 assert.equal(rows[0].querySelectorAll('button.digital-run-knowledge-toggle').length,1)
 assert.match(rows[0].querySelector('.digital-person-run-detail')!.textContent!,/静默/)
})
