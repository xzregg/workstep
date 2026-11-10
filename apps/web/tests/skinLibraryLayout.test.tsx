import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import SkinLibrary from '../src/components/SkinLibrary'
import { I18nProvider } from '../src/i18n'
import { defaultSkin } from '../src/skins/contract'

for (const width of [320, 390, 1023, 1280]) test(`appearance cards and device preview at ${width}px`, async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setWindowSize({ width, height: 900 })
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 280 } })
  const styles = document.head.appendChild(document.createElement('style'))
  styles.textContent = ':root { --mobile-control-regular: 32px; }' + ['components/SkinSettings.css', 'pages/AppearanceSettings.css', 'mobile.css'].map(path => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8')).join('\n')
  const host = document.body.appendChild(document.createElement('div'))
  host.className = 'settings-layout'
  const root = createRoot(host)
  const noop = () => {}
  try {
    await act(async () => root.render(<I18nProvider><div className="settings-content"><div className="settings-appearance-page skin-settings"><SkinLibrary documents={[defaultSkin(), ...Array.from({ length: 20 }, (_, index) => ({ ...defaultSkin(), manifest: { ...defaultSkin().manifest, id: `skin-${index}`, name: `自定义皮肤 ${index}` } }))]} activeId="default" busy={false} canManage={false} onCreate={noop} onPreview={noop} onApply={noop} onExport={noop} onDelete={noop} onRestore={noop} /></div></div></I18nProvider>))
    const card = host.querySelector<HTMLElement>('.skin-settings-card')!
    assert.notEqual(window.getComputedStyle(card).height, '32px', 'skin rows must leave room for name and metadata')
    assert.equal(host.querySelectorAll('.skin-settings-card').length, 21)
    assert.equal(host.querySelector('.skin-thumbnail'), null, 'library uses compact rows without repeated mock previews')
    const customMeta = host.querySelector('[data-skin-id="skin-0"] .skin-settings-card-meta')!
    assert.doesNotMatch(customMeta.textContent!, /自定义皮肤包/)
    assert.ok(customMeta.querySelector('[role="img"][aria-label="自定义皮肤包"][title="自定义皮肤包"] svg'))
    const listStyle = window.getComputedStyle(host.querySelector('.skin-settings-list')!)
    assert.equal(listStyle.gridTemplateColumns, 'repeat(2, minmax(0, 1fr))', 'compact library shows two skins per row')
    assert.equal(listStyle.overflowY, 'auto', 'large libraries scroll independently')
    assert.notEqual(listStyle.maxHeight, 'none')
    await act(async () => host.querySelector<HTMLButtonElement>('[data-skin-id="skin-19"]')!.click())
    assert.equal(host.querySelector('[data-skin-id="skin-19"]')!.getAttribute('aria-pressed'), 'true')
    assert.match(host.querySelector('.skin-settings-detail h2')!.textContent!, /自定义皮肤 19/)
    assert.match(host.querySelector('[data-skin-id="default"]')!.textContent!, /使用中/)
    const phone = host.querySelector<HTMLButtonElement>('.skin-settings-device-tabs button:last-child')!
    assert.equal(phone.getAttribute('aria-pressed'), String(width <= 1023))
    await act(async () => phone.click())
    const frame = host.querySelector<HTMLElement>('.skin-studio-preview-frame')!
    assert.equal(parseFloat(frame.style.width), 280, 'phone preview uses the available panel width')
    await act(async () => host.querySelector<HTMLButtonElement>('.skin-settings-device-tabs button:first-child')!.click())
    assert.equal(host.querySelector('.skin-studio-preview-frame.is-phone'), null, 'desktop preview remains selectable')
  } finally { await act(async () => root.unmount()); host.remove(); await window.happyDOM.close() }
})
