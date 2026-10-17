import { installDomEnvironment } from './helpers/domEnv'
import { indexedDB, IDBKeyRange } from 'fake-indexeddb'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import SkinWorkspaceFrame from '../src/components/SkinExtensions'
import { I18nProvider } from '../src/i18n'
import { defaultSkin } from '../src/skins/contract'
import { applySkin, currentSkin, restoreDefaultSkin } from '../src/skins/runtime'
import { setAppearanceScope } from '../src/utils/appearanceStorage'
import type { ExtensionApi, FeatureProps } from '../src/skins/extensions'
import SkinStudioPreview from '../src/components/SkinStudioPreview'

test('code requires consent, feature data persists, and switching skins preserves workspace DOM', async () => {
  const { window } = installDomEnvironment()
  Object.assign(globalThis, { indexedDB, IDBKeyRange, history: window.history })
  setAppearanceScope('feature-test')
  const skin = { ...defaultSkin(), manifest: { ...defaultSkin().manifest, id: 'feature-test', schema_version: 2 }, revision: 'one', script: 'theme.js', file_base: '/api/skins/files/one' }
  applySkin(skin)
  let loads = 0
  const loader = async () => { loads++; return { activate(api: ExtensionApi) {
    function TestFeature({ storage }: FeatureProps) {
      const [value, setValue] = api.React.useState('')
      api.React.useEffect(() => { void storage.get<string>('value').then(saved => setValue(saved ?? '')) }, [storage])
      return <button data-testid="feature-value" onClick={async () => { await storage.set('value', '已保存'); setValue('已保存') }}>{value || '保存测试数据'}</button>
    }
    api.features.register({ id: 'test-feature', title: '测试组件', render: TestFeature })
  } } }
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const render = () => root.render(<MemoryRouter><I18nProvider><SkinWorkspaceFrame onOpenSettings={() => {}} loadModule={loader}><div className="app-shell"><textarea aria-label="draft" defaultValue="保留的草稿" /></div></SkinWorkspaceFrame></I18nProvider></MemoryRouter>)
  const click = async (label: string) => act(async () => {
    const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === label)
    assert.ok(button, label); button.click()
  })
  const flush = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  try {
    await act(async () => render())
    const draft = document.querySelector('textarea')!
    assert.equal(loads, 0)
    await click('启用自定义组件')
    await act(async () => document.querySelector<HTMLButtonElement>('.confirm-dialog-confirm')!.click())
    await flush()
    assert.equal(loads, 1)
    await click('测试组件'); await flush()
    await click('保存测试数据'); await flush()
    assert.equal(document.querySelector('[data-testid="feature-value"]')!.textContent, '已保存')
    await act(async () => document.querySelector<HTMLButtonElement>('.skin-feature-panel > header button')!.click())
    await click('测试组件'); await flush()
    assert.equal(document.querySelector('[data-testid="feature-value"]')!.textContent, '已保存')
    await act(async () => applySkin(defaultSkin()))
    assert.equal(document.querySelector('.skin-feature-panel'), null)
    assert.equal(document.querySelector('textarea'), draft)
    assert.equal(draft.value, '保留的草稿')
    await act(async () => applySkin(skin)); await flush()
    assert.equal(loads, 2, 'same revision can activate again using its saved consent')
    await click('测试组件'); await flush()
    assert.equal(document.querySelector('[data-testid="feature-value"]')!.textContent, '已保存')
    await act(async () => applySkin({ ...skin, revision: 'two' })); await flush()
    assert.equal(loads, 2, 'a new code revision requires separate consent')
    assert.equal(document.querySelector('[data-testid="feature-value"]'), null)
  } finally {
    await act(async () => root.unmount())
    restoreDefaultSkin(); setAppearanceScope(null)
    host.remove(); await window.happyDOM.close()
  }
})

test('v2 thumbnail exposes layout and menu regions without executing code or escaping its style element', async () => {
  const { window } = installDomEnvironment()
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const skin = { ...defaultSkin(), manifest: { ...defaultSkin().manifest, id: 'thumbnail', schema_version: 2 }, layout: { composerPosition: 'left' as const },
    script: 'theme.js', css: '[data-ui="message"]::before{content:"</style><script>bad()</script>"}',
    menus: [{ id: 'tools', label: '日历', position: 'right' as const, items: [{ label: '打开', action: 'feature.open', args: { id: 'calendar' } }] }] }
  try {
    await act(async () => root.render(<I18nProvider><SkinStudioPreview skin={skin} compact={false} /></I18nProvider>))
    const iframe = host.querySelector('iframe')!
    const source = iframe.getAttribute('srcdoc')!
    assert.match(source, /data-ui="composer"/)
    assert.match(source, /data-composer-position="left"/)
    assert.match(source, /日历/)
    assert.doesNotMatch(source, /<script>/)
    assert.equal(iframe.getAttribute('sandbox'), 'allow-same-origin')
  } finally { await act(async () => root.unmount()); host.remove(); await window.happyDOM.close() }
})

test('a failed enabled module restores the working skin and leaves business inputs mounted', async () => {
  const { window } = installDomEnvironment()
  setAppearanceScope('recovery-test')
  const skin = { ...defaultSkin(), manifest: { ...defaultSkin().manifest, id: 'broken', schema_version: 2 }, revision: 'one', script: 'theme.js', file_base: '/api/skins/files/one' }
  localStorage.setItem('workstep:skin-code:recovery-test:broken:one', 'enabled')
  applySkin(skin)
  let loads = 0
  const loader = async () => { loads++; throw new Error('broken module') }
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  try {
    await act(async () => root.render(<MemoryRouter><I18nProvider><SkinWorkspaceFrame onOpenSettings={() => {}} loadModule={loader}><div className="app-shell"><input defaultValue="草稿" /></div></SkinWorkspaceFrame></I18nProvider></MemoryRouter>))
    assert.equal(currentSkin().manifest.id, 'default')
    assert.equal(host.querySelector('input')!.value, '草稿')
    assert.equal(loads, 1)
    assert.match(host.querySelector('[role="alert"]')!.textContent!, /broken module/)
  } finally {
    await act(async () => root.unmount()); setAppearanceScope(null); restoreDefaultSkin()
    host.remove(); await window.happyDOM.close()
  }
})
