import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { buildHookUrl, workflowHooksApi, type HookConfiguration } from '../src/api/workflowHooks'
import WorkflowHooksDialog from '../src/components/WorkflowHooksDialog'
import { I18nProvider } from '../src/i18n'

test('hook addresses keep identical paths and only simulation adds title and creator', () => {
  const hook = { id: 'hook', token: 'token', name: '测试', step_key: 'test', default_title: '默认', default_creator: '机器人', enabled: true, execution_mode: 'manual' as const }
  for (const base of ['https://gateway.example', 'http://192.168.1.2:8765', 'https://external.example']) {
    const url = new URL(buildHookUrl(base, 'device', hook))
    assert.equal(url.pathname, '/api/hook/device/hook')
    assert(!url.searchParams.has('title'))
    assert(!url.searchParams.has('creator'))
    const simulation = new URL(buildHookUrl(base, 'device', hook, { title: '标题 & 中文', creator: '张三' }))
    assert.equal(simulation.searchParams.get('title'), '标题 & 中文')
    assert.equal(simulation.searchParams.get('creator'), '张三')
  }
})

test('hook dialog separates simulation, saves multiple hooks and protects unsaved changes', async () => {
  const { window } = installDomEnvironment()
  const originalGet = workflowHooksApi.get, originalSave = workflowHooksApi.save
  const data: HookConfiguration = { device_id: 'device', gateway_online: false, addresses: [{ kind: 'gateway', base_url: 'https://gateway.example' }], steps: [{ key: 'design', name: '设计' }, { key: 'test', name: '测试' }], hooks: [{ id: 'hook', token: 'secret', name: '设计', step_key: '', default_title: '默认任务', default_creator: '机器人', enabled: true, execution_mode: 'manual' }] }
  let saved = 0
  workflowHooksApi.get = async () => data
  workflowHooksApi.save = async (_, __, hooks) => { saved = hooks.length; return { ...data, hooks: hooks.map((h, i) => ({ ...h, id: h.id || `new-${i}`, token: h.token || 'new-token' })) } }
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<I18nProvider><WorkflowHooksDialog projectId="p" workflowId="w" workflowName="研发" onClose={() => {}} /></I18nProvider>))
    const click = async (text: string) => { const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === text)!; assert.ok(button, text); await act(async () => button.click()) }
    assert.equal(document.querySelector('[data-testid="hook-title-override"]'), null)
    assert.equal(document.querySelectorAll('[data-testid="hook-address"]').length, 1)
    await click('模拟调用')
    assert.ok(document.querySelector('[data-testid="hook-title-override"]'))
    assert.match(document.body.textContent || '', /创建者：机器人/)
    await click('钩子配置')
    await click('新增钩子')
    await click('保存')
    assert.equal(saved, 2)
    await click('新增钩子')
    await click('关闭')
    assert.match(document.body.textContent || '', /有未保存的修改/)
  } finally {
    await act(async () => root.unmount())
    workflowHooksApi.get = originalGet; workflowHooksApi.save = originalSave
    await window.happyDOM.close()
  }
})
