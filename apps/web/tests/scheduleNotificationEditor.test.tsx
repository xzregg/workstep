import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { scheduleApi } from '../src/api/schedule'
import ScheduleNotificationEditor, {type NotificationEditorState} from '../src/components/ScheduleNotificationEditor'
import ScheduleRunNotification from '../src/components/ScheduleRunNotification'

const group = {id:'group:b:g',bot_id:'b',bot_name:'绑定机器人',label:'绑定群',target:{bot_id:'b',group_id:'g'}}
const session = {id:'session:s',bot_id:'other',bot_name:'另一个机器人',label:'项目会话',target:{session_id:'s'}}
async function setup() {
  const {window} = installDomEnvironment(); useLocaleStore.setState({locale:'zh-CN'})
  const original={...scheduleApi}; const root=createRoot(document.body.appendChild(document.createElement('div')))
  let latest:NotificationEditorState|undefined
  const render=async (taskId?:string, initialValue?:any) => act(async () => root.render(<I18nProvider><ScheduleNotificationEditor key={taskId || 'project'} projectId="p" taskId={taskId} initialValue={initialValue} onChange={state => {latest=state}} /></I18nProvider>))
  const select=async (label:string,value:string) => act(async () => {
    const input=document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!
    Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value')!.set!.call(input,value)
    input.dispatchEvent(new window.Event('change',{bubbles:true}))
  })
  const cleanup=async () => {await act(async () => root.unmount());Object.assign(scheduleApi,original);await window.happyDOM.close()}
  return {window,root,render,select,cleanup,latest:()=>latest}
}

test('task bound group defaults on; unbound task and project default off; explicit disabled wins',async () => {
  const app=await setup()
  scheduleApi.notificationOptions=async (_p,task) => ({choices:[group,session],default:task==='bound'?{enabled:true,target:group.target}:{enabled:false}})
  try {
    await app.render('bound');assert.equal(document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked,true)
    assert.equal(document.querySelector<HTMLSelectElement>('[aria-label="通知会话"]')!.value,group.id)
    await app.render('unbound');assert.equal(document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked,false)
    await app.render();assert.equal(app.latest()!.value.enabled,false)
    await app.render('bound',{enabled:false});assert.equal(app.latest()!.value.enabled,false)
  } finally {await app.cleanup()}
})

test('both kinds can select another bot/session and an enabled empty target blocks saving',async () => {
  const app=await setup();scheduleApi.notificationOptions=async () => ({choices:[group,session],default:{enabled:false}})
  try {
    await app.render('unbound')
    await act(async () => document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    assert.equal(app.latest()!.valid,false)
    await app.select('通知机器人','other')
    assert.deepEqual(app.latest(),{value:{enabled:true,target:{session_id:'s'}},valid:true})
    assert.equal(document.querySelector<HTMLSelectElement>('[aria-label="通知会话"]')!.value,'session:s')
  } finally {await app.cleanup()}
})

test('discovery failure blocks saving and reload recovers without silently enabling notifications',async () => {
  const app=await setup();let calls=0
  scheduleApi.notificationOptions=async () => {if (++calls===1) throw new Error('加载失败');return {choices:[session],default:{enabled:false}}}
  try {
    await app.render();assert.equal(app.latest()!.valid,false);assert.match(document.body.textContent!,/加载失败/)
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='重新加载会话')!.click())
    assert.equal(app.latest()!.valid,true);assert.equal(app.latest()!.value.enabled,false)
  } finally {await app.cleanup()}
})

test('notification retry uses only the occurrence endpoint and is hidden for read-only users',async () => {
  const app=await setup();let retries=0, refreshed=0
  scheduleApi.retryNotification=async (p,s,r) => {assert.deepEqual([p,s,r],['p','s','run']);retries++;return {ok:true}}
  const run:any={id:'run',notification_status:'failed',notification_error:'发送失败'}
  try {
    await act(async () => app.root.render(<I18nProvider><ScheduleRunNotification projectId="p" scheduleId="s" run={run} onRetried={()=>refreshed++} /></I18nProvider>))
    await act(async () => document.querySelector<HTMLButtonElement>('button')!.click())
    assert.equal(retries,1);assert.equal(refreshed,1)
    await act(async () => app.root.render(<I18nProvider><ScheduleRunNotification canRetry={false} projectId="p" scheduleId="s" run={run} onRetried={()=>{}} /></I18nProvider>))
    assert.equal(document.querySelector('button'),null)
  } finally {await app.cleanup()}
})
