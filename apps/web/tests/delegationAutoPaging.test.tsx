import {installDomEnvironment} from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {I18nProvider} from '../src/i18n'
import DigitalPersonHomeInsights from '../src/components/digital-person/DigitalPersonHomeInsights'
import DigitalPersonDelegationTimeline from '../src/components/digital-person/DigitalPersonDelegationTimeline'
import {digitalRuntimeApi,type DigitalActivityRecords} from '../src/api/digitalPerson'

const page=(offset:number,count=5):DigitalActivityRecords=>({checking:false,run_total:0,delegation_total:20,runs:[],delegations:Array.from({length:count},(_,i)=>({id:`d${offset+i}`,instruction:`任务${offset+i}`,status:'completed',project_id:'p',session_id:'s',created_at:new Date(Date.UTC(2026,10,20-offset-i)).toISOString()}))})

test('desktop scroll paging keeps order and position, coalesces, pauses on failure and stops on an empty page',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host),original=digitalRuntimeApi.records
 const calls:number[]=[]
 let finish:(data:DigitalActivityRecords)=>void=()=>{},fail:(error:Error)=>void=()=>{}
 digitalRuntimeApi.records=async(_r=0,d=0)=>{calls.push(d);if(!d)return page(0);return new Promise((resolve,reject)=>{finish=resolve;fail=reject})}
 try{
  await act(async()=>root.render(<I18nProvider><DigitalPersonHomeInsights active name="测试" state="idle" activity={null} affect={null} chatShown={false} onInspect={()=>{}}/></I18nProvider>))
  const list=host.querySelector<HTMLElement>('[data-activity-scroll]')!
  Object.defineProperties(list,{clientHeight:{value:200},scrollHeight:{configurable:true,value:1000}})
  list.scrollTop=700
  const scroll=()=>list.dispatchEvent(new window.Event('scroll'))
  await act(async()=>scroll());assert.deepEqual(calls,[0])
  list.scrollTop=750
  await act(async()=>{scroll();scroll()});assert.deepEqual(calls,[0,5])
  assert.match(list.querySelector('[role=status]')!.textContent!,/Loading|加载/)
  await act(async()=>finish(page(5)))
  assert.equal(list.scrollTop,750)
  assert.deepEqual([...list.querySelectorAll('strong')].map(row=>row.textContent),Array.from({length:10},(_,i)=>`任务${i}`))
  assert.ok(list.querySelector('.digital-home-work-next') === null)
  await act(async()=>scroll());assert.deepEqual(calls,[0,5,10])
  await act(async()=>fail(new Error('offline')))
  assert.ok(list.querySelector('[role=alert]'))
  await act(async()=>{scroll();scroll()});assert.deepEqual(calls,[0,5,10])
  await act(async()=>list.querySelector<HTMLButtonElement>('.digital-home-work-next')!.click())
  assert.deepEqual(calls,[0,5,10,10])
  await act(async()=>finish(page(10,0)))
  await act(async()=>{scroll();scroll()});assert.deepEqual(calls,[0,5,10,10])
  assert.ok(list.querySelector('.digital-home-work-next') === null)
 }finally{await act(async()=>root.unmount());digitalRuntimeApi.records=original;await window.happyDOM.close()}
})

test('desktop fills a short visible list while mobile keeps its manual entry',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 let compact=false,calls=0
 window.matchMedia=(()=>({matches:compact,addEventListener(){},removeEventListener(){}})) as any
 const height=Object.getOwnPropertyDescriptor(window.HTMLElement.prototype,'clientHeight')
 Object.defineProperty(window.HTMLElement.prototype,'clientHeight',{configurable:true,get(){return 300}})
 const render=(loading=false,pageError=false,canLoadMore=true)=>root.render(<I18nProvider><DigitalPersonDelegationTimeline items={page(0).delegations} viewedResults={{}} loading={loading} pageError={pageError} canLoadMore={canLoadMore} onLoadMore={()=>{calls++}} onOpen={()=>{}}/></I18nProvider>)
 try{
  await act(async()=>render());assert.equal(calls,1);assert.ok(host.querySelector('.digital-home-work-next') === null)
  await act(async()=>render(true));assert.equal(calls,1)
  await act(async()=>render(false,true));assert.equal(calls,1)
  await act(async()=>render(false,false,false));assert.equal(calls,1)
  compact=true
  await act(async()=>render());assert.equal(calls,1)
  assert.match(host.querySelector('.digital-home-work-next')!.textContent!,/Load earlier tasks|加载更早的任务/)
  await act(async()=>host.querySelector<HTMLButtonElement>('.digital-home-work-next')!.click());assert.equal(calls,2)
 }finally{await act(async()=>root.unmount());if(height)Object.defineProperty(window.HTMLElement.prototype,'clientHeight',height);await window.happyDOM.close()}
})
