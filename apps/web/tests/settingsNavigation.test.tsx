import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import SettingsNavigation from '../src/components/SettingsNavigation'
import { useManagedModeStore } from '../src/stores/managedModeStore'

test('settings navigation has one current section and changes sections by click', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let selected = ''
  try {
    await act(async () => root.render(
      <I18nProvider>
        <SettingsNavigation activeSection="providers" onSelect={(section) => { selected = section }} />
      </I18nProvider>,
    ))
    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
    assert.equal(buttons.length, 10)
    assert.equal(buttons.filter((button) => button.getAttribute('aria-current') === 'page').length, 1)
    assert.equal(buttons[0].getAttribute('aria-current'), 'page')
    assert.ok(buttons.every((button) => button.classList.contains('settings-nav-button')))
    assert.ok(buttons.every((button) => !button.hasAttribute('style')))
    await act(async () => buttons[1].click())
    assert.equal(selected, 'engines')
    await act(async () => buttons[6].click())
    assert.equal(selected, 'remote')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

test('managed settings hide the legacy remote project section', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  useManagedModeStore.setState({ managed: true })
  try {
    await act(async () => root.render(
      <I18nProvider>
        <SettingsNavigation activeSection="providers" onSelect={() => {}} />
      </I18nProvider>,
    ))
    assert.equal(container.querySelectorAll('button').length, 9)
    assert.doesNotMatch(container.textContent ?? '', /远程项目/)
  } finally {
    await act(async () => root.unmount())
    useManagedModeStore.setState({ managed: null, loading: false })
    container.remove()
    await window.happyDOM.close()
  }
})
