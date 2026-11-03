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
    await act(async () => root.render(<I18nProvider><div className="settings-content"><div className="settings-appearance-page skin-settings"><SkinLibrary documents={[defaultSkin()]} activeId="default" busy={false} canManage={false} onCreate={noop} onPreview={noop} onApply={noop} onExport={noop} onDelete={noop} onRestore={noop} /></div></div></I18nProvider>))
    const card = host.querySelector<HTMLElement>('.skin-settings-card')!
    assert.notEqual(window.getComputedStyle(card).height, '32px', 'skin cards must retain their thumbnail and name instead of a regular button height')
    const phone = host.querySelector<HTMLButtonElement>('.skin-settings-device-tabs button:last-child')!
    assert.equal(phone.getAttribute('aria-pressed'), String(width <= 1023))
    await act(async () => phone.click())
    const frame = host.querySelector<HTMLElement>('.skin-studio-preview-frame')!
    assert.equal(parseFloat(frame.style.width), 280, 'phone preview uses the available panel width')
    await act(async () => host.querySelector<HTMLButtonElement>('.skin-settings-device-tabs button:first-child')!.click())
    assert.equal(host.querySelector('.skin-studio-preview-frame.is-phone'), null, 'desktop preview remains selectable')
  } finally { await act(async () => root.unmount()); host.remove(); await window.happyDOM.close() }
})
