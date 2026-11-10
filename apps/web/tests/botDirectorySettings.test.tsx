import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import BotDirectorySettings from '../src/components/BotDirectorySettings'
import type { ChannelBot } from '../src/api/channelBots'

const bot = { id:'bot', platform:'dingtalk', enabled:true, directory_enabled:true,
  capabilities:{ directory:true, directory_fields:[] } } as unknown as ChannelBot

test('directory searches only local API, refreshes explicitly and saves disabled state', async () => {
  const { window } = installDomEnvironment()
  const original = globalThis.fetch
  const calls: string[] = [], saved: any[] = [], dirty: boolean[] = []
  const onDirty = (value: boolean) => { dirty.push(value) }
  const onBusy = () => {}
  useLocaleStore.setState({ locale:'zh-CN' })
  globalThis.fetch = async (url, init) => {
    calls.push(`${init?.method || 'GET'} ${url}`)
    if (init?.method === 'PATCH') { saved.push(JSON.parse(String(init.body))); return Response.json(bot) }
    if (String(url).includes('/contacts')) return Response.json({ contacts:[{ contact_id:'u1', name:'张三', departments:['研发'], user_id:'u1' }], total:1 })
    return Response.json({ status:'ready', count:1, updated_at:'2026-11-09T00:00:00Z', error:'' })
  }
  const container=document.body.appendChild(document.createElement('div')), root=createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><BotDirectorySettings bot={bot} onDirtyChange={onDirty} onBusyChange={onBusy} /></I18nProvider>))
    assert.match(container.textContent!, /张三/)
    assert.match(container.textContent!, /仅缓存在内存/)
    assert.equal(calls.filter(row => row.startsWith('POST')).length, 0)
    const input=container.querySelector<HTMLInputElement>('input[placeholder]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(input,'张')
      input.dispatchEvent(new window.Event('input',{bubbles:true}))
    })
    assert.equal(calls.filter(row => row.startsWith('POST')).length, 0)
    await act(async () => [...container.querySelectorAll('button')].find(row => row.textContent==='更新通讯录')!.click())
    assert.equal(calls.filter(row => row.startsWith('POST')).length, 1)
    await act(async () => container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click())
    assert.equal(dirty.at(-1),true)
    await act(async () => [...container.querySelectorAll('button')].find(row => row.textContent==='保存通讯录配置')!.click())
    assert.equal(saved[0].directory_enabled,false)
    assert.equal('proactive_send_enabled' in saved[0],false)
    assert.equal(dirty.at(-1),false)
    assert.equal(container.querySelector('table'),null)
  } finally { await act(async () => root.unmount()); container.remove(); globalThis.fetch=original }
})

test('WeCom directory validates credentials and retains existing secret', async () => {
  installDomEnvironment()
  const original=globalThis.fetch, saved:any[]=[]
  globalThis.fetch=async (_url, init) => {
    if (init?.method==='PATCH') { saved.push(JSON.parse(String(init.body))); return Response.json({has_directory_secret:true}) }
    return Response.json({status:'idle',count:0,error:'',updated_at:null})
  }
  const container=document.body.appendChild(document.createElement('div')),root=createRoot(container)
  const value={...bot, enabled:false, platform:'wecom', directory_enabled:false, directory_corp_id:'corp', directory_agent_id:'1', has_directory_secret:true,
    capabilities:{directory:true,directory_fields:['directory_corp_id','directory_agent_id','directory_secret']}} as ChannelBot
  try {
    await act(async () => root.render(<I18nProvider><BotDirectorySettings bot={value} onDirtyChange={() => {}} onBusyChange={() => {}} /></I18nProvider>))
    await act(async () => container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click())
    assert.match(container.textContent!, /Agent ID/)
    assert.match(container.textContent!, /完全一致/)
    const button=[...container.querySelectorAll('button')].find(row => row.textContent==='保存通讯录配置')!
    assert.equal(button.disabled,false)
    await act(async () => button.click())
    assert.equal(saved[0].directory_secret,undefined)
  } finally { await act(async () => root.unmount()); container.remove(); globalThis.fetch=original }
})
