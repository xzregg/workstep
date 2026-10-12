import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import SidebarLoadStatus from '../src/components/SidebarLoadStatus'
import { I18nProvider } from '../src/i18n'

test('sidebar loading text can grow while the rotating ring keeps its square size', async () => {
  const { window } = installDomEnvironment()
  const css = await readFile(new URL('../src/components/SidebarLoadStatus.css', import.meta.url), 'utf8')
  const sharedCss = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')
  const stylesheet = document.head.appendChild(document.createElement('style'))
  stylesheet.textContent = `${sharedCss.match(/\.spinner\s*\{[^}]*\}/)![0]}\n${css}`
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><SidebarLoadStatus loading label="加载失败" onRetry={() => {}} /></I18nProvider>))
    const spinner = container.querySelector('.spinner')!
    const style = window.getComputedStyle(spinner as never)
    assert.equal(style.flexGrow, '0', 'loading ring must never fill the row')
    assert.equal(style.flexShrink, '0')
    assert.equal(style.width, '14px')
    assert.equal(style.height, '14px')
    assert.match(style.animation, /task-status-spin.*infinite/)
    assert.equal(window.getComputedStyle(container.querySelector('.sidebar-load-status-text') as never).flexGrow, '1')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
