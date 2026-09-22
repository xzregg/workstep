import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const mobileCss = await readFile(new URL('../src/mobile.css', import.meta.url), 'utf8')
const settingsSource = await readFile(new URL('../src/pages/SettingsPage.tsx', import.meta.url), 'utf8')
const providerSource = await readFile(new URL('../src/pages/ProviderSettings.tsx', import.meta.url), 'utf8')
const pricingSource = await readFile(new URL('../src/pages/ModelPricingSettings.tsx', import.meta.url), 'utf8')

test('mobile switches and checkbox rows align to the shared button height', () => {
  assert.match(settingsSource, /className="settings-switch"/)
  assert.match(settingsSource, /className="settings-switch-thumb"/)
  assert.match(pricingSource, /className="settings-switch"/)
  assert.match(pricingSource, /className="settings-switch-thumb"/)
  assert.match(mobileCss, /\.settings-switch\s*\{[^}]*width:\s*52px[^}]*height:\s*var\(--mobile-button-height\)/s)
  assert.match(mobileCss, /\.settings-switch-thumb\s*\{[^}]*width:\s*28px[^}]*height:\s*28px/s)
  assert.match(mobileCss, /input\[type="checkbox"\]:not\(\[role="switch"\]\)\s*\{[^}]*width:\s*16px[^}]*height:\s*16px/s)
  assert.match(mobileCss, /input\[type="checkbox"\]\[role="switch"\]\s*\{[^}]*appearance:\s*none[^}]*width:\s*52px[^}]*height:\s*var\(--mobile-button-height\)/s)
  assert.match(mobileCss, /label:has\(> input\[type="checkbox"\]\)\s*\{[^}]*min-height:\s*var\(--mobile-button-height\)/s)
  assert.match(mobileCss, /\.provider-protocol-switch,[\s\S]*?\.channel-toggle span\s*\{[^}]*width:\s*52px[^}]*height:\s*var\(--mobile-button-height\)/s)
})

test('provider settings stack heading, actions and card controls on mobile', () => {
  assert.match(providerSource, /className="provider-settings-page"/)
  assert.match(providerSource, /className="provider-settings-header"/)
  assert.match(providerSource, /className="provider-settings-header-actions"/)
  assert.match(providerSource, /className="provider-settings-card-row"/)
  assert.match(providerSource, /className="provider-settings-card-actions"/)
  assert.match(mobileCss, /\.provider-settings-header\s*\{[^}]*flex-direction:\s*column/s)
  assert.match(mobileCss, /\.provider-settings-card-row\s*\{[^}]*grid-template-columns:\s*34px minmax\(0, 1fr\)/s)
  assert.match(mobileCss, /\.provider-settings-card-actions\s*\{[^}]*grid-column:\s*1 \/ -1/s)
})

test('engine settings keep descriptions readable and actions on their own row', () => {
  assert.match(settingsSource, /className="engine-settings-page"/)
  assert.match(settingsSource, /className="engine-settings-header"/)
  assert.match(settingsSource, /className="engine-settings-section-heading"/)
  assert.match(settingsSource, /className="engine-settings-card-row"/)
  assert.match(settingsSource, /className="engine-settings-card-summary"/)
  assert.match(settingsSource, /className="engine-settings-card-actions"/)
  assert.match(mobileCss, /\.engine-settings-header\s*\{[^}]*flex-direction:\s*column/s)
  assert.match(mobileCss, /\.engine-settings-card-row\s*\{[^}]*grid-template-columns:\s*32px 34px minmax\(0, 1fr\)/s)
  assert.match(mobileCss, /\.engine-settings-card-actions\s*\{[^}]*grid-column:\s*1 \/ -1/s)
})
