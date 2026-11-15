import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import SettingsNavigation from '../src/components/SettingsNavigation'
import { useManagedModeStore } from '../src/stores/managedModeStore'

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
    assert.equal(container.querySelectorAll('button').length, 17)
    assert.doesNotMatch(container.textContent ?? '', /远程项目/)
    assert.match(container.textContent ?? '', /远程访问|Remote access/)
    assert.doesNotMatch(container.textContent ?? '', /网关平台/)
  } finally {
    await act(async () => root.unmount())
    useManagedModeStore.setState({ managed: null, loading: false })
    container.remove()
    await window.happyDOM.close()
  }
})
