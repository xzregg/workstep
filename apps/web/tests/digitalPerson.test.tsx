import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from '../src/i18n'
import { assistantApi, providerApi } from '../src/api/client'
import { digitalPersonApi } from '../src/api/digitalPerson'
import { DIGITAL_PERSON_CHANGED, useDigitalPerson } from '../src/components/digital-person/useDigitalPerson'
import DigitalPersonSettings from '../src/components/digital-person/DigitalPersonSettings'

test('digital person persists its profile, guards drafts, and shows native memory', async () => {
  const { window } = installDomEnvironment()
  const rootElement = document.body.appendChild(document.createElement('div'))
  const root = createRoot(rootElement)
  let profile = { onboarding_completed: true, enabled: false, name: '小研', role: '研发伙伴', personality: '直接', duties: '跟进研发', avatar: 'robot' as const, greeting: '你好' }
  const oldGet = digitalPersonApi.get, oldSave = digitalPersonApi.save
  digitalPersonApi.get = async () => ({ ...profile })
  digitalPersonApi.save = async value => { profile = { ...value } as typeof profile; return profile }
  const oldList = assistantApi.list, oldProviders = providerApi.list, oldConfig = assistantApi.setConfig
  assistantApi.list = async () => ({ assistants: [{ name: 'digital_person', fields: ['engine'], configured: {}, resolved: {}, available_engines: [] }] } as any)
  providerApi.list = async () => ({ providers: [] } as any)
  let dirty = false
  try {
    await act(async () => root.render(<MemoryRouter><I18nProvider><DigitalPersonSettings onClose={() => {}} onDirtyChange={value => { dirty = value }} /></I18nProvider></MemoryRouter>))
    const click = async (text: string) => { await act(async () => {
      const button = [...rootElement.querySelectorAll('button')].find(b => b.textContent === text || (text === '保存' && b.textContent === 'Save'))
      assert.ok(button, text); button.click()
    }) }
    assert.match(rootElement.textContent!, /小研/)
    assert.doesNotMatch(rootElement.textContent!, /默认工作区/)
    const style = document.createElement('style')
    style.textContent = await readFile(new URL('../src/components/digital-person/DigitalPersonAvatar.css', import.meta.url), 'utf8') + await readFile(new URL('../src/components/digital-person/DigitalPersonSettings.css', import.meta.url), 'utf8')
    document.head.appendChild(style)
    for (const width of [320, 390, 1023]) {
      await act(async () => window.happyDOM.setWindowSize({ width, height: 844 })); style.textContent += '\n'
      const avatar = rootElement.querySelector('.digital-person-avatar')!
      assert.equal(getComputedStyle(avatar).width, '56px')
      assert.equal(getComputedStyle(avatar).borderRadius, '50%')
      assert.notEqual(getComputedStyle(rootElement.querySelector('header')!).position, 'sticky', 'profile header scrolls with settings content; the outer dialog owns its fixed header')
    }
    await click('编辑档案')
    const input = rootElement.querySelector<HTMLInputElement>('input[name="name"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, '小舟')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    assert.equal(dirty, true)
    const save = digitalPersonApi.save
    digitalPersonApi.save = async () => { throw new Error('模拟保存失败') }
    await click('保存')
    assert.match(rootElement.textContent!, /模拟保存失败/)
    assert.equal(profile.name, '小研'); assert.equal(dirty, true)
    digitalPersonApi.save = save
    await click('保存')
    assert.equal(profile.name, '小舟'); assert.equal(dirty, false)
    const toggle = rootElement.querySelector<HTMLButtonElement>('header [role="switch"]')!
    assert.ok(toggle, 'enabled switch belongs in the header')
    assert.equal(toggle.getAttribute('aria-checked'), 'false')
    await act(async () => toggle.click())
    assert.equal(profile.enabled, true)
    const workingSave = digitalPersonApi.save
    digitalPersonApi.save = async () => { throw new Error('开关保存失败') }
    await act(async () => toggle.click())
    assert.equal(toggle.getAttribute('aria-checked'), 'true')
    digitalPersonApi.save = workingSave
    await act(async () => toggle.click())
    assert.equal(profile.enabled, false)
    assert.equal(rootElement.querySelectorAll('[data-body-part]').length, 7)
    await click('主动性')
    const intervalInput = rootElement.querySelector<HTMLInputElement>('input[name="proactive_interval_minutes"]')!
    assert.ok(intervalInput)
    assert.equal(rootElement.querySelector('.schedule-page'), null)
    assert.ok(rootElement.querySelector('input[type="checkbox"]'))
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(intervalInput, '15')
      intervalInput.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    const delegationInput = rootElement.querySelector<HTMLInputElement>('input[name="delegation_interval_seconds"]')!
    assert.ok(delegationInput)
    assert.equal(delegationInput.value,'60')
    await act(async()=>{
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!.call(delegationInput,'3')
      delegationInput.dispatchEvent(new window.Event('input',{bubbles:true}))
    })
    const shared = rootElement.querySelector<HTMLInputElement>('input[name="proactive_shared_context"]')!
    assert.ok(shared)
    assert.equal(shared.checked, true)
    await act(async () => shared.click())
    await click('保存')
    assert.equal((profile as any).proactive_interval_minutes, 15)
    assert.equal((profile as any).delegation_interval_seconds, 3)
    assert.equal((profile as any).proactive_shared_context, false)
    await click('大脑')
    assert.ok(rootElement.querySelector('[aria-label="' + '默认助手引擎' + '"]') || rootElement.querySelector('select'))
    assert.equal(rootElement.querySelector('textarea[name="conversation_rules"]'), null)
    let savedAssistant = ''
    assistantApi.setConfig = async (name) => { savedAssistant = name; return { configured: {}, resolved: {} } as any }
    await act(async () => rootElement.querySelector<HTMLButtonElement>('.assistant-engine-footer button')!.click())
    assert.equal(savedAssistant, 'digital_person')
    assert.doesNotMatch(rootElement.textContent!, /流程助手|任务创建助手/)
    await click('记忆')
    assert.equal(rootElement.querySelector('[role="tab"][aria-selected="true"]')?.textContent, '记忆')
    assert.ok(rootElement.querySelector('[role="tabpanel"]'))
    assert.equal(rootElement.querySelector('iframe'), null)
    assert.ok(rootElement.querySelector('.digital-person-memory-map'))
  } finally {
    assistantApi.list = oldList; providerApi.list = oldProviders; assistantApi.setConfig = oldConfig
    digitalPersonApi.get = oldGet; digitalPersonApi.save = oldSave
    await act(async () => root.unmount()); rootElement.remove(); await window.happyDOM.close()
  }
})


test('chat identity only loads in eligible workspace and clears when disabled', async () => {
  const { window } = installDomEnvironment()
  const element = document.body.appendChild(document.createElement('div')), root = createRoot(element)
  const oldGet = digitalPersonApi.get
  let calls = 0, enabled = true
  digitalPersonApi.get = async () => { calls++; return { enabled, name: '小研', role: '', personality: '', duties: '研发', avatar: 'robot', greeting: '你好' } }
  function Surface({ eligible }: { eligible: boolean }) { const profile = useDigitalPerson(eligible); return <output>{profile?.name || '普通对话'}</output> }
  try {
    await act(async () => root.render(<Surface eligible={false} />))
    assert.equal(calls, 0)
    await act(async () => root.render(<Surface eligible />))
    assert.equal(element.textContent, '小研')
    enabled = false
    await act(async () => window.dispatchEvent(new window.Event(DIGITAL_PERSON_CHANGED)))
    assert.equal(element.textContent, '普通对话')
    await act(async () => root.render(<Surface eligible={false} />))
    const before = calls
    await act(async () => window.dispatchEvent(new window.Event(DIGITAL_PERSON_CHANGED)))
    assert.equal(calls, before)
  } finally {
    digitalPersonApi.get = oldGet
    await act(async () => root.unmount()); element.remove(); await window.happyDOM.close()
  }
})
