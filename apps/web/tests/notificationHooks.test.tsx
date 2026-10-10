import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import NotificationHooksDialog from '../src/components/NotificationHooksDialog'
import { notificationHooksApi, type NotificationHook } from '../src/api/notificationHooks'

test('notification targets separate preview and explicit delivery, preserve drafts and show history', async () => {
  const { window, document } = installDomEnvironment()
  useLocaleStore.getState().setLocale('zh-CN')
  const original = { ...notificationHooksApi }
  const hook: NotificationHook = { id:'hook',name:'研发群',platform:'generic',url:'https://receiver.example/hook',secret:'',enabled:true,events:['completed','failed'],prefix:'研发通知',include_link:true,link_base:'gateway' }
  let sent = 0, saved = 0, switched = 0
  notificationHooksApi.get = async () => ({ hooks:[hook],addresses:[{kind:'gateway',base_url:'https://gateway.example'}] })
  notificationHooksApi.save = async (_,__,hooks) => { saved=hooks.length; return { hooks:hooks.map((h,i)=>({...h,id:h.id||`new-${i}`})),addresses:[] } }
  notificationHooksApi.preview = async () => ({ payload:{event:'completed'},snapshot:{task:{title:'修复登录校验'}},subscribed:true })
  notificationHooksApi.test = async () => { sent++;return {delivery_id:'test'} }
  notificationHooksApi.records = async () => ({ deliveries:[{id:'delivery',event:'completed',title:'任务',status:'sent',attempts:1,created_at:0,updated_at:0,result:'发送成功',next_at:0}] })
  const root=createRoot(document.body.appendChild(document.createElement('div')))
  const click=async(text:string)=>{const button=[...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===text);assert.ok(button,text);await act(async()=>button.click())}
  try {
    await act(async()=>root.render(<I18nProvider><NotificationHooksDialog projectId="p" workflowId="w" workflowName="研发" onClose={()=>{}} onSwitchType={()=>{switched++}} /></I18nProvider>))
    assert.equal((document.querySelector('[data-testid="notification-url"]') as HTMLInputElement).type,'password')
    await click('模拟通知');await click('生成预览');assert.equal(sent,0)
    assert.match(document.body.textContent||'',/修复登录校验/)
    await click('发送测试通知');assert.equal(sent,0)
    await click('确认发送');assert.equal(sent,1)
    await click('投递记录');assert.match(document.body.textContent||'',/发送成功/)
    await click('通知配置');await click('新增通知钩子')
    assert.equal(( [...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent==='保存')!).disabled,true)
    await click('触发钩子');assert.equal(switched,0);assert.match(document.body.textContent||'',/未保存/)
    await click('取消');assert.equal(saved,0)
  } finally { await act(async()=>root.unmount());Object.assign(notificationHooksApi,original);await window.happyDOM.close() }
})
