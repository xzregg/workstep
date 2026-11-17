import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import SettingsHelpButton, { settingsManualChapters } from '../src/components/SettingsHelpButton'
import { featureChapters } from '../../landing/src/manual/features'
import { onboardingChapters } from '../../landing/src/manual/onboarding'

test('every advertised settings help target exists in the website manual', () => {
  const ids = new Set([...featureChapters, ...onboardingChapters].map(chapter => chapter.id))
  for (const [section, chapter] of Object.entries(settingsManualChapters)) assert.ok(ids.has(chapter), section)
})

test('digital person and decision help point to their newly documented capabilities', () => {
  assert.equal(settingsManualChapters['digital-person'], 'digital-person')
  assert.equal(settingsManualChapters.decision, 'settings-troubleshooting')
})

test('settings help opens the corresponding local chapter, follows language and closes independently', async () => {
  const { window } = installDomEnvironment()
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  useLocaleStore.setState({ locale: 'zh-CN', language: null })
  try {
    await act(async () => root.render(<I18nProvider><h1>流程模板<SettingsHelpButton section="templates" /></h1></I18nProvider>))
    const button = host.querySelector<HTMLButtonElement>('.settings-help-button')!
    assert.ok(button)
    await act(async () => button.click())
    let frame = document.querySelector<HTMLIFrameElement>('.manual-help-frame')!
    assert.equal(frame.getAttribute('src'), '/landing/?embed=1&lang=zh-CN#docs/templates-ai-flow')
    await act(async () => useLocaleStore.setState({ locale: 'en-US' }))
    frame = document.querySelector<HTMLIFrameElement>('.manual-help-frame')!
    assert.match(frame.getAttribute('src')!, /lang=en-US#docs\/templates-ai-flow$/)
    let opened: string[] = []
    window.open = ((...args: string[]) => { opened = args; return null }) as typeof window.open
    await act(async () => document.querySelector<HTMLButtonElement>('.manual-help-browser')!.click())
    assert.deepEqual(opened, ['/landing/?lang=en-US#docs/templates-ai-flow', '_blank', 'noopener,noreferrer'])
    assert.ok(document.querySelector('.manual-help-overlay'), 'opening a browser keeps the reader open')
    await act(async () => document.querySelector<HTMLButtonElement>('.manual-help-close')!.click())
    assert.equal(document.querySelector('.manual-help-overlay'), null)
    assert.ok(host.querySelector('h1'))
  } finally {
    await act(async () => root.unmount())
    window.happyDOM.abort()
  }
})

test('decision settings now opens its documented manual chapter', async () => {
  const { window } = installDomEnvironment()
  const host = document.body.appendChild(document.createElement('div')), root = createRoot(host)
  try {
    await act(async () => root.render(<I18nProvider><SettingsHelpButton section="decision" /></I18nProvider>))
    const button = host.querySelector<HTMLButtonElement>('button')!
    assert.ok(button)
    await act(async () => button.click())
    assert.match(document.querySelector<HTMLIFrameElement>('.manual-help-frame')!.getAttribute('src')!, /#docs\/settings-troubleshooting$/)
  } finally {
    await act(async () => root.unmount())
    window.happyDOM.abort()
  }
})
