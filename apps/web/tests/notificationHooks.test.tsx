import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import NotificationHooksDialog from '../src/components/NotificationHooksDialog'
import { notificationHooksApi, type NotificationHook, type NotificationRecord } from '../src/api/notificationHooks'

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

async function mountNotificationDialog() {
  const { window, document } = installDomEnvironment()
  useLocaleStore.getState().setLocale('zh-CN')
  const original = { ...notificationHooksApi }
  const hook: NotificationHook = { id:'hook',name:'研发群',platform:'generic',url:'https://receiver.example/one',secret:'',enabled:true,events:['completed','failed'],prefix:'',include_link:true,link_base:'external' }
  notificationHooksApi.get = async () => ({hooks:[hook],addresses:[{kind:'external',base_url:'https://work.example'}]})
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  let closed = 0
  const button = (text:string) => {
    const found = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b=>b.textContent===text)
    assert.ok(found, text)
    return found
  }
  const click = async (text:string) => { const target=button(text);assert.equal(target.disabled,false,text);await act(async()=>target.click()) }
  const input = async (selector:string,value:string) => {
    const target=document.querySelector<HTMLInputElement>(selector)
    assert.ok(target,selector)
    await act(async()=>{
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(target,value)
      target.dispatchEvent(new window.Event('input',{bubbles:true}))
    })
  }
  return {document,hook,button,click,input,
    closed:()=>closed,
    render:async()=>act(async()=>root.render(<I18nProvider><NotificationHooksDialog projectId="p" workflowId="w" workflowName="研发" onClose={()=>{closed++}} onSwitchType={()=>{}}/></I18nProvider>)),
    cleanup:async()=>{await act(async()=>root.unmount());Object.assign(notificationHooksApi,original);await window.happyDOM.close()},
  }
}

test('multiple notification targets retain edits after save failure and delete only after confirmation', async()=>{
  const ui=await mountNotificationDialog()
  let saved:NotificationHook[]=[]
  let reject=true
  notificationHooksApi.save=async(_,__,hooks)=>{
    if(reject)throw new Error('保存失败，请重试')
    saved=structuredClone(hooks).map((h,i)=>({...h,id:h.id||`new-${i}`}))
    return {hooks:saved,addresses:[{kind:'external',base_url:'https://work.example'}]}
  }
  try {
    await ui.render()
    await ui.click('新增通知钩子')
    assert.equal(ui.button('保存').disabled,true)
    await ui.input('[data-testid="notification-url"]','https://receiver.example/two')
    await ui.click('保存')
    assert.match(ui.document.body.textContent||'',/保存失败，请重试/)
    assert.equal((ui.document.querySelector('[data-testid="notification-url"]') as HTMLInputElement).value,'https://receiver.example/two')
    assert.equal(ui.button('保存').disabled,false)
    await ui.click('关闭')
    assert.equal(ui.closed(),0)
    await ui.click('取消')
    reject=false
    await ui.click('保存')
    assert.equal(saved.length,2)
    assert.deepEqual(saved.map(h=>h.url),['https://receiver.example/one','https://receiver.example/two'])
    assert.equal(ui.button('保存').disabled,true)
    await ui.click('删除钩子')
    await ui.click('取消')
    assert.equal(ui.button('保存').disabled,true)
    await ui.click('删除钩子')
    await ui.click('确认')
    assert.equal(saved.length,2)
    await ui.click('保存')
    assert.equal(saved.length,1)
    assert.equal(saved[0].id,'hook')
    await ui.click('关闭')
    assert.equal(ui.closed(),1)
  } finally {await ui.cleanup()}
})

test('delivery history recovers from errors, paginates and retries the selected failed record',async()=>{
  const ui=await mountNotificationDialog()
  const offsets:number[]=[]
  const retries:string[]=[]
  let reject=true, retried=false
  const record=(i:number,status:NotificationRecord['status']='sent'):NotificationRecord=>({id:`delivery-${i}`,event:'completed',title:`任务 ${i}`,status,attempts:1,created_at:i,updated_at:i,result:status==='failed'?'HTTP 400':'发送成功',next_at:0})
  notificationHooksApi.records=async(_,__,hookId,offset=0)=>{
    assert.equal(hookId,'hook');offsets.push(offset)
    if(reject)throw new Error('记录读取失败')
    return {deliveries:offset===0?Array.from({length:50},(_,i)=>record(i,i===0&&!retried?'failed':'sent')):[record(50)]}
  }
  notificationHooksApi.retry=async(_,__,hookId,id)=>{assert.equal(hookId,'hook');retries.push(id);retried=true;return {delivery_id:id}}
  try {
    await ui.render()
    await ui.click('投递记录')
    assert.match(ui.document.body.textContent||'',/记录读取失败/)
    reject=false
    await ui.click('刷新')
    assert.equal(ui.document.querySelectorAll('tbody tr').length,50)
    await ui.click('重试投递')
    assert.deepEqual(retries,['delivery-0'])
    assert.doesNotMatch(ui.document.body.textContent||'',/HTTP 400/)
    await ui.click('下一页')
    assert.equal(ui.document.querySelectorAll('tbody tr').length,1)
    assert.match(ui.document.body.textContent||'',/任务 50/)
    assert.equal(ui.button('下一页').disabled,true)
    await ui.click('上一页')
    assert.deepEqual(offsets,[0,0,0,50,0])
  } finally {await ui.cleanup()}
})
