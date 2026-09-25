import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { TaskArtifact } from '../src/api/client'
import { I18nProvider } from '../src/i18n'
import TaskMessageArtifacts from '../src/components/TaskMessageArtifacts'

test('message artifacts open the selected output by mouse and keyboard', async () => {
  const { window } = installDomEnvironment()
  const artifact = { name: 'report.md', path: '.workstep/artifacts/report.md',
    step_key: 'build', round: 2, is_dir: false } as TaskArtifact
  const opened: unknown[][] = []
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><TaskMessageArtifacts
      artifacts={[artifact]} stepColor="#123456"
      onOpenArtifact={(...args) => opened.push(args)}
    /></I18nProvider>))
    const row = container.querySelector<HTMLElement>('[role="button"]')!
    assert.match(row.textContent || '', /report\.md/)
    await act(async () => row.click())
    await act(async () => row.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })))
    assert.deepEqual(opened, [
      ['report.md', 'build', 2, '.workstep/artifacts/report.md'],
      ['report.md', 'build', 2, '.workstep/artifacts/report.md'],
    ])
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
