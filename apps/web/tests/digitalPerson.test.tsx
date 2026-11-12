import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider } from '../src/i18n'
import { digitalPersonApi } from '../src/api/digitalPerson'
import { DIGITAL_PERSON_CHANGED, useDigitalPerson } from '../src/components/digital-person/useDigitalPerson'
import DigitalPersonSettings from '../src/components/digital-person/DigitalPersonSettings'

test('digital person persists its profile, guards drafts, and shows original brain', async () => {
  const { window } = installDomEnvironment()
  const rootElement = document.body.appendChild(document.createElement('div'))
  const root = createRoot(rootElement)
  let profile = { enabled: false, name: '小研', role: '研发伙伴', personality: '直接', duties: '跟进研发', avatar: 'robot' as const, greeting: '你好' }
  const oldGet = digitalPersonApi.get, oldSave = digitalPersonApi.save
  digitalPersonApi.get = async () => ({ ...profile })
  digitalPersonApi.save = async value => { profile = { ...value } as typeof profile; return profile }
  let dirty = false
  try {
    await act(async () => root.render(<MemoryRouter><I18nProvider><DigitalPersonSettings onClose={() => {}} onDirtyChange={value => { dirty = value }} /></I18nProvider></MemoryRouter>))
    const click = async (text: string) => { await act(async () => {
      const button = [...rootElement.querySelectorAll('button')].find(b => b.textContent === text || (text === '保存' && b.textContent === 'Save'))
      assert.ok(button, text); button.click()
    }) }
    assert.match(rootElement.textContent!, /小研/)
    assert.doesNotMatch(rootElement.textContent!, /默认工作区/)
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
    await click('开启数字人')
    await click('开启数字人')
    assert.equal(profile.enabled, true)
    await click('关闭数字人')
    assert.equal(profile.enabled, false)
    await click('记忆')
    const brain = rootElement.querySelector('iframe')!
    assert.match(brain.src, /human-brain.html/)
    assert.equal(brain.getAttribute('sandbox'), 'allow-scripts')
  } finally {
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
