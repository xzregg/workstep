import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import TaskArtifactBrowser from '../src/components/TaskArtifactBrowser'
import { I18nProvider } from '../src/i18n'
import type { TaskArtifact } from '../src/api/client'

test('round tabs start at the right edge and preserve manual scrolling until another round arrives', async () => {
  const { window } = installDomEnvironment()
  Object.defineProperties(window.HTMLElement.prototype, {
    scrollWidth: { configurable: true, get: () => 800 },
    clientWidth: { configurable: true, get: () => 160 },
  })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const render = (count: number) => root.render(<I18nProvider><TaskArtifactBrowser
    artifacts={Array.from({ length: count }, (_, index) => ({
      step_key: 'design', round: index + 1, name: 'design.md', path: `design/${index + 1}/design.md`,
    } as TaskArtifact))}
    steps={[{ key: 'design', label: 'UI 设计' }]}
    onOpenArtifact={() => {}}
  /></I18nProvider>)
  try {
    await act(async () => render(8))
    const tabs = container.querySelector<HTMLElement>('[role="tablist"]')!
    assert.equal(tabs.scrollLeft, 640)
    assert.equal(tabs.querySelector('[aria-selected="true"]'), tabs.lastElementChild)

    tabs.scrollLeft = 40
    await act(async () => tabs.querySelector<HTMLButtonElement>('[role="tab"]')!.click())
    assert.equal(tabs.scrollLeft, 40)
    await act(async () => render(8))
    assert.equal(tabs.scrollLeft, 40)

    await act(async () => render(9))
    assert.equal(tabs.scrollLeft, 640)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
