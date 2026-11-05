import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import SkinSettings from '../src/components/SkinSettings'
import SkinWorkspaceFrame from '../src/components/SkinExtensions'
import SkinRecovery from '../src/components/SkinRecovery'
import { I18nProvider } from '../src/i18n'
import { skinsApi } from '../src/api/skins'
import { defaultSkin } from '../src/skins/contract'
import { restoreDefaultSkin, currentSkin, saveSkin } from '../src/skins/runtime'

const ocean = { ...defaultSkin(), manifest: { ...defaultSkin().manifest, id: 'ocean', name: '海洋' }, revision: 'v1', tokens: { accent: '#0077aa' } }
for (const schemaVersion of [1, 2]) test(`v${schemaVersion} preview is cancellable and confirmed skins leave no recovery bar`, async () => {
  const { window } = installDomEnvironment()
  restoreDefaultSkin()
  const oldList = skinsApi.list, oldGet = skinsApi.get
  skinsApi.list = async () => [{ manifest: ocean.manifest, revision: 'v1' }]
  skinsApi.get = async () => ({ ...ocean, manifest: { ...ocean.manifest, schema_version: schemaVersion } })
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<MemoryRouter><I18nProvider><SkinSettings /><SkinRecovery /></I18nProvider></MemoryRouter>))
    const click = async (text: string) => act(async () => { const button = [...document.querySelectorAll('button')].find(b => b.textContent?.includes(text)); assert.ok(button, text); button.click() })
    await act(async () => document.querySelector<HTMLButtonElement>('.skin-settings-card[data-skin-id="ocean"]')!.click())
    assert.equal(currentSkin().manifest.id, 'default', 'selecting a library card does not apply it')
    assert.ok(document.querySelector('.skin-settings-detail iframe'))
    await click('预览')
    assert.equal(currentSkin().manifest.id, 'ocean')
    assert.ok(document.querySelector('[data-skin-recovery]'))
    await click('取消预览')
    assert.equal(currentSkin().manifest.id, 'default')
    await click('应用')
    assert.equal(currentSkin().manifest.id, 'ocean')
    assert.equal(document.querySelector('[data-skin-recovery]'), null)
    assert.equal(document.documentElement.style.getPropertyValue('--skin-recovery-height'), '0px')
    const restore = document.querySelector<HTMLButtonElement>('.skin-settings-detail button[aria-label="恢复默认皮肤"]')!
    assert.ok(restore, 'restoration remains available in appearance settings')
    await act(async () => restore.click())
    assert.equal(currentSkin().manifest.id, 'default')
    assert.equal(document.querySelector('.skin-settings-footer-note button'), null)
  } finally { skinsApi.list = oldList; skinsApi.get = oldGet; await act(async () => root.unmount()); restoreDefaultSkin(); await window.happyDOM.close() }
})

test('skin library filters and searches packages while leaving the active appearance unchanged', async () => {
  const { window } = installDomEnvironment()
  restoreDefaultSkin()
  const oldList = skinsApi.list, oldGet = skinsApi.get
  skinsApi.list = async () => [{ manifest: ocean.manifest, revision: 'v1' }]
  skinsApi.get = async () => ocean
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<MemoryRouter><I18nProvider><SkinSettings /></I18nProvider></MemoryRouter>))
    assert.equal(document.querySelectorAll('.skin-settings-card').length, 2)
    assert.equal(document.querySelectorAll('.skin-settings-tabs [role=tab]').length, 2)
    assert.doesNotMatch(document.querySelector('.skin-settings-tabs')!.textContent!, /当前使用/)
    assert.equal(document.querySelector('.skin-settings-create-card'), null)
    assert.match(document.querySelector('.skin-settings-library-toolbar')?.textContent ?? '', /导入 ZIP/)
    assert.match(document.querySelector('.skin-settings-card[data-skin-id="default"]')!.textContent!, /使用中/)
    const input = document.querySelector<HTMLInputElement>('.skin-settings-search input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, '海洋')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    assert.equal(document.querySelectorAll('.skin-settings-card').length, 1)
    assert.equal(currentSkin().manifest.id, 'default')
  } finally { skinsApi.list = oldList; skinsApi.get = oldGet; await act(async () => root.unmount()); restoreDefaultSkin(); await window.happyDOM.close() }
})

test('complete override coverage reports zero inherited parts', async () => {
  const { window } = installDomEnvironment()
  restoreDefaultSkin()
  const oldList = skinsApi.list, oldValidate = skinsApi.validate
  skinsApi.list = async () => []
  const checked = { ...ocean, coverage: { overridden: ['button'], inherited: [] } }
  skinsApi.validate = async () => ({ ok: true, skin: checked, coverage: checked.coverage, checks: [], visual_checked: false })
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<MemoryRouter><I18nProvider><SkinSettings /></I18nProvider></MemoryRouter>))
    const input = document.querySelector('.skin-settings-package input') as HTMLInputElement
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, '/tmp/skin')
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === '校验')!.click())
    assert.match(document.querySelector('.skin-settings-package [role=status]')!.textContent!, /继承 0 个部位/)
  } finally { skinsApi.list = oldList; skinsApi.validate = oldValidate; await act(async () => root.unmount()); restoreDefaultSkin(); await window.happyDOM.close() }
})


test('appearance script switch persists across remounts, runs updates, and stops components immediately', async () => {
  const { window } = installDomEnvironment()
  restoreDefaultSkin()
  const originalList = skinsApi.list, originalGet = skinsApi.get
  const scripted = { ...ocean, script: 'theme.js', file_base: '/api/skins/files/one' }
  skinsApi.list = async () => [{ manifest: scripted.manifest, revision: scripted.revision }]
  skinsApi.get = async () => scripted
  let loads = 0, stops = 0
  const loader = async () => ({ activate() { loads++; return () => { stops++ } } })
  const host = document.body.appendChild(document.createElement('div'))
  let root = createRoot(host)
  const render = () => root.render(<MemoryRouter><I18nProvider><SkinWorkspaceFrame onOpenSettings={() => {}} loadModule={loader}><SkinSettings /></SkinWorkspaceFrame></I18nProvider></MemoryRouter>)
  const select = async () => act(async () => document.querySelector<HTMLButtonElement>('.skin-settings-card[data-skin-id="ocean"]')!.click())
  const toggle = () => document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="运行皮肤脚本"]')!
  try {
    await act(async () => render())
    assert.equal(toggle().disabled, true, 'default skin has no script')
    await select()
    assert.equal(toggle().getAttribute('aria-checked'), 'false')
    await act(async () => toggle().click())
    assert.equal(toggle().getAttribute('aria-checked'), 'true')
    assert.equal(loads, 0, 'enabling a selected skin does not apply it or execute its preview thumbnail')
    await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === '应用')!.click())
    assert.equal(loads, 1)
    await act(async () => root.unmount())
    root = createRoot(host)
    await act(async () => render())
    assert.equal(toggle().getAttribute('aria-checked'), 'true')
    assert.equal(loads, 2, 'saved permission activates automatically on remount')
    await act(async () => toggle().click())
    assert.equal(stops, 2, 'switching off immediately cleans up the running module')
    assert.equal(toggle().getAttribute('aria-checked'), 'false')
    await act(async () => root.unmount())
    root = createRoot(host)
    await act(async () => render())
    assert.equal(loads, 2, 'disabled preference survives remount')
    assert.equal(toggle().getAttribute('aria-checked'), 'false')
  } finally {
    skinsApi.list = originalList; skinsApi.get = originalGet
    await act(async () => root.unmount()); restoreDefaultSkin(); host.remove(); await window.happyDOM.close()
  }
})


test('an updated installed skin can replace an active older revision with the same ID', async () => {
  const { window } = installDomEnvironment()
  const previousList = skinsApi.list, previousGet = skinsApi.get
  const updated = { ...ocean, manifest: { ...ocean.manifest, schema_version: 2 }, revision: 'updated', css: '[data-starry]{border:0}' }
  saveSkin(ocean)
  skinsApi.list = async () => [{ manifest: updated.manifest, revision: updated.revision }]
  skinsApi.get = async () => updated
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<MemoryRouter><I18nProvider><SkinSettings /></I18nProvider></MemoryRouter>))
    const apply = [...document.querySelectorAll<HTMLButtonElement>('.skin-settings-detail footer button')].find(button => button.textContent === '应用')
    assert.ok(apply, 'a different package revision must offer Apply instead of Already applied')
    assert.equal(apply.disabled, false)
    await act(async () => apply.click())
    assert.equal(currentSkin().revision, 'updated')
    assert.match(document.getElementById('workstep-skin-style')!.textContent!, /data-starry/)
  } finally {
    await act(async () => root.unmount()); skinsApi.list = previousList; skinsApi.get = previousGet
    restoreDefaultSkin(); await window.happyDOM.close()
  }
})
