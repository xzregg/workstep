import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act, useRef } from 'react'
import { useOverlay } from '../src/hooks/useOverlay'
import { createRoot } from 'react-dom/client'
import Select from '../src/components/Select'
import EngineSelect from '../src/components/EngineSelect'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { defaultSkin } from '../src/skins/contract'
import { saveSkin, restoreDefaultSkin } from '../src/skins/runtime'

test('skin select opens a themed list, respects disabled and forwards a real change once', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.getState().setLocale('zh-CN')
  saveSkin({ ...defaultSkin(), manifest: { ...defaultSkin().manifest, id: 'ocean' } })
  const changes: string[] = []
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<I18nProvider><Select value="a" onChange={e => changes.push(e.target.value)} aria-label="test"><optgroup label="group"><option value="a">A</option><option value="b" disabled>B</option><option value="c">C</option></optgroup></Select></I18nProvider>))
    await act(async () => (document.querySelector('[role=combobox]') as HTMLButtonElement).click())
    assert.ok(document.querySelector('[role=listbox]'))
    assert.equal((document.querySelector('[data-value=b]') as HTMLButtonElement).disabled, true)
    await act(async () => (document.querySelector('[data-value=c]') as HTMLButtonElement).click())
    assert.deepEqual(changes, ['c'])
    assert.equal(document.querySelector('[role=listbox]'), null)
    assert.equal(document.activeElement, document.querySelector('[role=combobox]'))
    await act(async () => (document.querySelector('[role=combobox]') as HTMLButtonElement).click())
    await act(async () => document.querySelector('[role=listbox]')!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    assert.equal(document.querySelector('[role=listbox]'), null)
  } finally { await act(async () => root.unmount()); restoreDefaultSkin(); await window.happyDOM.close() }
})

test('engine cards retain unavailable reasons and never select an unconfigured engine', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.getState().setLocale('zh-CN')
  saveSkin({ ...defaultSkin(), manifest: { ...defaultSkin().manifest, id: 'ocean' }, layout: { engineAppearance: 'cards' } })
  const changes: string[] = []
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<I18nProvider><EngineSelect engines={[{ id: 'codex', installed: true, configured: true, verified: true, built_in: false, mode: 'cli' }, { id: 'claude', installed: true, configured: false, verified: false, built_in: false, mode: 'cli' }]} value="codex" onChange={v => changes.push(v)} /></I18nProvider>))
    await act(async () => (document.querySelector('[role=combobox]') as HTMLButtonElement).click())
    assert.ok(document.querySelector('.skin-select-options--cards'))
    assert.match(document.querySelector('[data-value=claude]')!.textContent!, /配置/)
    assert.equal((document.querySelector('[data-value=claude]') as HTMLButtonElement).disabled, true)
    assert.deepEqual(changes, [])
  } finally { await act(async () => root.unmount()); restoreDefaultSkin(); await window.happyDOM.close() }
})


test('Escape closes only a selector nested inside a dialog', async () => {
  const { window } = installDomEnvironment()
  saveSkin({ ...defaultSkin(), manifest: { ...defaultSkin().manifest, id: 'ocean' } })
  let parentClosed = 0
  function Surface() {
    const ref = useRef<HTMLDivElement>(null)
    useOverlay(true, () => { parentClosed += 1 }, ref, false)
    return <div ref={ref}><Select value="a" onChange={() => {}}><option value="a">A</option><option value="b">B</option></Select></div>
  }
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<I18nProvider><Surface /></I18nProvider>))
    await act(async () => (document.querySelector('[role=combobox]') as HTMLButtonElement).click())
    await act(async () => document.querySelector('[role=listbox]')!.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    assert.equal(parentClosed, 0)
    assert.equal(document.querySelector('[role=listbox]'), null)
  } finally { await act(async () => root.unmount()); restoreDefaultSkin(); await window.happyDOM.close() }
})

test('default appearance uses the same searchable popup even with only two options', async () => {
  const { window } = installDomEnvironment()
  restoreDefaultSkin()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const changes: string[] = []
  try {
    await act(async () => root.render(<I18nProvider><label>授权资源<Select defaultValue="a" onChange={event => changes.push(event.target.value)}><option value="a">设备甲</option><option value="b">设备乙</option></Select></label></I18nProvider>))
    const trigger = document.querySelector<HTMLButtonElement>('[role=combobox]')
    assert.ok(trigger, 'default appearance must not open a browser-native select menu')
    assert.equal(document.querySelector('select')?.getAttribute('aria-hidden'), 'true')
    await act(async () => trigger.click())
    const search = document.querySelector<HTMLInputElement>('.skin-select-search')!
    assert.ok(search, 'search is available regardless of option count')
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(search, '设备乙')
      search.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    assert.equal(document.querySelector('[data-value=a]'), null)
    await act(async () => document.querySelector<HTMLButtonElement>('[data-value=b]')!.click())
    assert.deepEqual(changes, ['b'])
    assert.equal(document.activeElement, trigger)
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})
