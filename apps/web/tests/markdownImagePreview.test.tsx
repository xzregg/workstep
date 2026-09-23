import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { Window } from 'happy-dom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import MarkdownMessage from '../src/components/MarkdownMessage'
import { I18nProvider, useLocaleStore } from '../src/i18n'

test('shared Markdown images open and close the image preview by default', async () => {
  useLocaleStore.getState().setLocale('zh-CN')
  const window = new Window({ url: 'http://localhost/' })
  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)

  try {
    await act(async () => root.render(
      <I18nProvider>
        <MarkdownMessage content={'![界面截图](.workstep/uploads/screen.png)'} projectId="project-1" />
      </I18nProvider>,
    ))
    const thumbnail = container.querySelector<HTMLButtonElement>('.markdown-image-click')
    assert.ok(thumbnail)
    await act(async () => thumbnail.click())
    const preview = document.querySelector<HTMLElement>('.image-preview')
    assert.ok(preview)
    assert.equal(preview.querySelector('img')?.getAttribute('src'), thumbnail.querySelector('img')?.getAttribute('src'))
    await act(async () => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })))
    assert.equal(document.querySelector('.image-preview'), null)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
