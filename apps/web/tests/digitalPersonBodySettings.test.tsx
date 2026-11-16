import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { digitalPersonApi, digitalRuntimeApi, voiceWakeApi } from '../src/api/digitalPerson'
import { assistantApi, providerApi } from '../src/api/client'
import { speechOutputApi } from '../src/api/speechOutput'
import { outputStatus } from './fixtures/speechOutput'
import DigitalPersonSettings from '../src/components/digital-person/DigitalPersonSettings'

test('body settings routes head to engine and memory, preserves identity presets and guards dirty navigation', async () => {
  const { window } = installDomEnvironment(), host = document.body.appendChild(document.createElement('div')), root = createRoot(host)
  useLocaleStore.setState({ locale: 'zh-CN' })
  const get = digitalPersonApi.get, activity = digitalRuntimeApi.activity, records = digitalRuntimeApi.records, list = assistantApi.list, providers = providerApi.list
  digitalPersonApi.get = async () => ({ enabled: true, onboarding_completed: true, name: '小研', role: '研发伙伴', personality: '严谨', tone: '简洁直接', duties: '跟进工作', avatar: 'robot', greeting: '你好' })
  digitalRuntimeApi.activity = async () => ({ level: 1, experience: 0, next_level_experience: 10, session_count: 12, reply_count: 38, task_count: 7, completed_task_count: 5, feedback: {}, suggestions: [], runs: [], answers: [], delegations: [], checking: false })
  digitalRuntimeApi.records = async () => ({ checking: false, run_total: 0, delegation_total: 0, runs: [], delegations: [] })
  assistantApi.list = async () => ({ assistants: [{ name: 'digital_person', fields: ['engine'], configured: {}, resolved: {}, available_engines: [] }] } as any)
  providerApi.list = async () => ({ providers: [] } as any)
  const click = async (selector: string) => act(async () => { const button = host.querySelector<HTMLButtonElement>(selector); assert.ok(button, selector); button.click() })
  try {
    await act(async () => root.render(<MemoryRouter><I18nProvider><DigitalPersonSettings onClose={() => {}} /></I18nProvider></MemoryRouter>))
    assert.equal(host.querySelector('.digital-person-header h1')?.textContent, '数字形象')
    assert.equal(host.querySelector('.digital-person-header-title > button')?.textContent,'初始引导')
    assert.doesNotMatch(host.querySelector('.digital-person-actions')!.textContent!,/初始引导/)
    await click('.digital-person-header-title > button')
    assert.ok(host.querySelector('.digital-person-header .digital-person-guide'),'setup controls stay beside the header action')
    await click('.digital-person-guide button')
    await click('[data-settings-tab=card]')
    assert.equal(host.querySelectorAll('[data-body-part]').length, 8)
    assert.equal(host.querySelectorAll('.digital-person-secondary-nav .digital-person-menu-icon').length,11)
    assert.equal(host.querySelector('[data-settings-tab=card] span')?.getAttribute('data-short-label'),'true')
    assert.equal(host.querySelector('[data-settings-tab=identity] span')?.getAttribute('data-short-label'),'false')
    assert.deepEqual([...host.querySelectorAll('.digital-person-secondary-nav button')].map(button => button.getAttribute('data-settings-tab')), ['card','identity','appearance','proactive','channels','memory','assistant','input','vision','tools','activity'])
    assert.ok(host.querySelector('.digital-person-body-navigation .digital-person-secondary-nav'))
    const sidebar=host.querySelector('.digital-person-body-navigation')!
    assert.equal(sidebar.firstElementChild?.className,'digital-person-secondary-settings')
    assert.equal(sidebar.children[1]?.className,'digital-person-body-map')
    assert.doesNotMatch(sidebar.textContent!,/其他设置|基本选项/)
    assert.equal(host.querySelector('#digital-person-panel .digital-person-secondary-nav'),null)
    assert.equal(host.querySelector<HTMLDetailsElement>('.digital-person-card-details')?.open,true,'desktop duties start expanded')
    assert.ok(host.querySelector('.digital-person-card .digital-person-relationship'))
    assert.equal(host.querySelector('.digital-person-body-navigation .digital-person-relationship'),null)
    const bodyNavigation=host.querySelector('.digital-person-body-navigation')
    const auxiliaryLabels=[...host.querySelectorAll('.digital-person-secondary-nav button')].map(button=>button.textContent)
    assert.equal(host.querySelector('.digital-person-body-identity'), null)
    await click('[data-body-part=feet]')
    assert.equal(host.querySelector('#digital-person-panel-title')?.textContent, '运行记录')
    assert.ok(host.querySelector('.digital-person-activity'))
    assert.equal(host.querySelector('.digital-person-stat-counts'), null)
    assert.equal(host.querySelector('[data-settings-tab=activity]')?.getAttribute('aria-pressed'), 'true')
    await click('[data-settings-tab=card]')
    assert.ok(host.querySelector('.digital-person-card .digital-person-stat-counts'))
    await click('[data-part=feet] .digital-person-body-point')
    assert.ok(host.querySelector('.digital-person-activity'), 'foot marker also opens run history')
    await click('[data-settings-tab=card]')
    await click('[data-settings-tab=activity]')
    assert.equal(host.querySelector('[data-body-part=feet]')?.getAttribute('aria-pressed'), 'true')
    await click('[data-body-part=brain]')
    assert.ok(host.querySelector('.assistant-engine-root'))
    assert.equal(host.querySelector('.digital-person-brain-tabs'),null)
    await click('[data-body-part=memory]')
    assert.ok(host.querySelector('.digital-person-memory-map'))
    assert.equal(host.querySelector('.digital-person-relationship'),null,'relationship only belongs to the namecard')
    assert.equal(host.querySelector('.digital-person-body-navigation'),bodyNavigation,'same humanoid survives content switches')
    assert.equal(host.querySelector('[data-body-part=memory]')?.getAttribute('aria-pressed'),'true')
    assert.equal(host.querySelector('[data-settings-tab=memory]')?.getAttribute('aria-pressed'),'true')
    assert.equal(host.querySelector('[data-body-part=brain]')?.getAttribute('aria-pressed'),'false')
    assert.deepEqual([...host.querySelectorAll('.digital-person-secondary-nav button')].map(button=>button.textContent),auxiliaryLabels)
    await click('[data-part=memory] .digital-person-body-point')
    assert.ok(host.querySelector('.digital-person-memory-map'))
    assert.equal(host.querySelector('.digital-person-relationship'),null,'relationship only belongs to the namecard')
    await click('.digital-person-secondary-nav [data-settings-tab=identity]')
    assert.match(host.querySelector('.digital-person-secondary-nav [data-settings-tab=identity]')!.textContent!, /人设与职责/)
    assert.equal(host.querySelectorAll('.digital-person-documents .markdown-editor-root').length, 3)
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>('.digital-person-document-tags button')].find(button => button.textContent === '耐心')!.click())
    await click('[data-body-part=heart]')
    assert.ok(host.querySelector('[data-document=persona]'), 'dirty identity stays visible until discard is confirmed')
    assert.match(document.body.textContent!, /放弃未保存/)
  } finally {
    await act(async () => root.unmount()); await window.happyDOM.close()
    digitalPersonApi.get = get; digitalRuntimeApi.activity = activity; digitalRuntimeApi.records = records; assistantApi.list = list; providerApi.list = providers
  }
})


test('digital appearance selects unified output, guards drafts and retains saved voice when saving avatar', async () => {
  const { window } = installDomEnvironment(), host = document.body.appendChild(document.createElement('div')), root = createRoot(host)
  useLocaleStore.setState({ locale: 'zh-CN' })
  const oldOutput = { ...speechOutputApi }, oldPerson = { ...digitalPersonApi }, activity = digitalRuntimeApi.activity
  let profile = { enabled: true, onboarding_completed: true, name: '小研', role: '研发伙伴', personality: '严谨', duties: '跟进工作', avatar: 'robot', greeting: '你好', voice_rate: 1, auto_speak: false } as Awaited<ReturnType<typeof digitalPersonApi.get>>
  let gets = 0, selected = ''
  digitalPersonApi.get = async () => { gets++; return { ...profile } }
  digitalPersonApi.save = async value => { profile = { ...value }; return profile }
  digitalRuntimeApi.activity = async () => ({ feedback: {}, suggestions: [], runs: [], answers: [], delegations: [], checking: false })
  speechOutputApi.status = async () => ({ ...structuredClone(outputStatus), settings: { ...structuredClone(outputStatus.settings), mode: 'local', voice: '46' } })
  speechOutputApi.save = async value => { selected = value.voice; return value }
  const click = async (selector: string) => act(async () => host.querySelector<HTMLButtonElement>(selector)!.click())
  try {
    await act(async () => root.render(<MemoryRouter><I18nProvider><DigitalPersonSettings onClose={() => {}} /></I18nProvider></MemoryRouter>))
    await click('[data-body-part=mouth]')
    assert.ok(host.querySelector('.speech-output-settings'), 'mouth opens the same output settings as global settings')
    assert.equal(gets, 1, 'reuse the already-loaded profile on initial output mount')
    assert.equal(host.querySelector('.speech-output-settings input[type=radio]'), null)
    assert.equal(host.querySelector('[data-output-model]'), null)
    assert.equal(host.querySelector('.speech-output-model-manager'), null)
    assert.ok(host.querySelector('.speech-output-settings select'), 'voice remains selectable')
    const rate = host.querySelector<HTMLInputElement>('.speech-output-row input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(rate, '1.3')
      rate.dispatchEvent(new window.Event('input', { bubbles: true }))
      host.querySelector<HTMLInputElement>('.speech-output-check input')!.click()
    })
    assert.equal(host.querySelector<HTMLButtonElement>('.digital-person-form-actions button')!.disabled, true)
    await click('[data-body-part=feet]')
    assert.match(document.body.textContent!, /放弃未保存/)
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === '取消')!.click())
    await click('[data-save-output]')
    assert.equal(selected, '46')
    assert.equal(profile.voice_rate, 1.3)
    assert.equal(profile.auto_speak, true)
    const avatar = host.querySelector<HTMLSelectElement>('.digital-person-appearance-form select')!
    await act(async () => { avatar.value = 'spark'; avatar.dispatchEvent(new window.Event('change', { bubbles: true })) })
    const saveAvatar = digitalPersonApi.save
    let release!: () => void
    digitalPersonApi.save = async value => { await new Promise<void>(resolve => { release = resolve }); return saveAvatar(value) }
    await click('.digital-person-form-actions button')
    assert.equal(host.querySelector<HTMLFieldSetElement>('.speech-output-settings fieldset')!.disabled, true)
    await act(async () => { release(); await new Promise(resolve => setImmediate(resolve)) })
    assert.equal(profile.avatar, 'spark')
    assert.equal(profile.voice_rate, 1.3)
    assert.equal(profile.auto_speak, true)
  } finally {
    await act(async () => root.unmount()); await window.happyDOM.close()
    Object.assign(speechOutputApi, oldOutput); Object.assign(digitalPersonApi, oldPerson); digitalRuntimeApi.activity = activity
  }
})


test('ears only edits wake parameters without model management or microphone capture', async () => {
  const { window } = installDomEnvironment(), host = document.body.appendChild(document.createElement('div')), root = createRoot(host)
  useLocaleStore.setState({ locale: 'zh-CN' })
  const oldPerson = { ...digitalPersonApi }, oldWake = { ...voiceWakeApi }, activity = digitalRuntimeApi.activity
  digitalPersonApi.get = async () => ({ enabled: true, onboarding_completed: true, name: '小研', role: '伙伴', personality: '', duties: '工作', avatar: 'robot', greeting: '你好' })
  digitalRuntimeApi.activity = async () => ({ feedback: {}, suggestions: [], runs: [], answers: [], delegations: [], checking: false })
  voiceWakeApi.get = async () => ({ keyword: '你好小研', sensitivity: 'balanced' } as any)
  let saved = ''
  voiceWakeApi.save = async value => { saved = value.keyword; return value as any }
  try {
    await act(async () => root.render(<MemoryRouter><I18nProvider><DigitalPersonSettings onClose={() => {}} /></I18nProvider></MemoryRouter>))
    await act(async () => host.querySelector<HTMLButtonElement>('[data-body-part=ears]')!.click())
    assert.ok(host.querySelector('.voice-wake-settings'))
    assert.equal(host.querySelector('.speech-settings'), null)
    assert.equal(host.querySelector('[data-test-wake]'), null)
    assert.equal(host.querySelector('.digital-person-wake'), null)
    const input = host.querySelector<HTMLInputElement>('.voice-wake-settings input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, '你好伙伴')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    await act(async () => host.querySelector<HTMLButtonElement>('[data-save-wake]')!.click())
    assert.equal(saved, '你好伙伴')
  } finally {
    await act(async () => root.unmount()); await window.happyDOM.close()
    Object.assign(digitalPersonApi, oldPerson); Object.assign(voiceWakeApi, oldWake); digitalRuntimeApi.activity = activity
  }
})
