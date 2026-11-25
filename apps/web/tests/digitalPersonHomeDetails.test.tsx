import {installDomEnvironment} from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {I18nProvider,useLocaleStore} from '../src/i18n'
import DigitalPersonHomeDetails from '../src/components/digital-person/DigitalPersonHomeDetails'
import {digitalRuntimeApi,type DigitalActivityRecords} from '../src/api/digitalPerson'

test('thought history restores the native menu and preserves expansion, paging and retry',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 const original={records:digitalRuntimeApi.records,detail:digitalRuntimeApi.runDetail},locale=useLocaleStore.getState().locale
 useLocaleStore.setState({locale:'zh-CN'})
 const messages:unknown[]=[],requests:number[]=[]
 window.WorkStepAndroid={postMessage:(raw:string)=>messages.push(JSON.parse(raw))}
 const records:DigitalActivityRecords={checking:false,run_total:6,delegation_total:0,runs:[{id:'first',summary:'长文本'.repeat(100),status:'completed',created_at:'2026-11-23T01:00:00Z'}],delegations:[]}
 let fail=true
 digitalRuntimeApi.records=async(offset=0)=>{requests.push(offset);if(fail)throw new Error('分页失败');return {...records,runs:[{...records.runs[0],id:'last',summary:'最后一页'}]}}
 digitalRuntimeApi.runDetail=async id=>({id,status:'completed',summary:'完整思考正文'.repeat(100),created_at:'2026-11-23'})
 const render=(kind:'reflection'|'profile')=>root.render(<I18nProvider><DigitalPersonHomeDetails kind={kind} name="测试" state="idle" activity={null} affect={null} records={records} onClose={()=>root.render(null)}/></I18nProvider>)
 try{
  await act(async()=>render('reflection'))
  assert.deepEqual(messages,[{type:'thought-history',open:true}])
  const toggle=()=>document.querySelector<HTMLButtonElement>('.digital-home-detail-run-header')!
  await act(async()=>toggle().click())
  assert.equal(toggle().getAttribute('aria-expanded'),'true')
  assert.equal(toggle().getAttribute('aria-controls'),'digital-run-first')
  assert.match(document.querySelector('.digital-person-run-detail')!.textContent!,/完整思考正文/)
  await act(async()=>toggle().click())
  assert.ok(document.querySelector('.digital-person-run-detail') === null)
  await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="下一页"]')!.click())
  assert.match(document.querySelector('[role="alert"]')!.textContent!,/分页失败/)
  fail=false
  await act(async()=>document.querySelector<HTMLButtonElement>('[role="alert"] button')!.click())
  assert.match(toggle().textContent!,/最后一页/)
  assert.equal(toggle().getAttribute('aria-expanded'),'false')
  assert.deepEqual(requests,[5,5])
  assert.equal(document.querySelector<HTMLButtonElement>('[aria-label="下一页"]')!.disabled,true)
  await act(async()=>document.querySelector<HTMLButtonElement>('[aria-label="上一页"]')!.click())
  assert.match(toggle().textContent!,/长文本/)
  await act(async()=>render('profile'))
  assert.deepEqual(messages,[{type:'thought-history',open:true},{type:'thought-history',open:false}])
  await act(async()=>render('reflection'))
  await act(async()=>document.querySelector<HTMLButtonElement>('.digital-home-detail-close')!.click())
  assert.deepEqual(messages.slice(-2),[{type:'thought-history',open:true},{type:'thought-history',open:false}])
 }finally{await act(async()=>root.unmount());Object.assign(digitalRuntimeApi,{records:original.records,runDetail:original.detail});useLocaleStore.setState({locale});await window.happyDOM.close()}
})
