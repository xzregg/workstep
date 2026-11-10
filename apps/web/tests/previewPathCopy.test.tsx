import './helpers/domEnv.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import CopyablePath from '../src/components/CopyablePath.tsx'
import { I18nProvider } from '../src/i18n/index.tsx'
import { installDomEnvironment } from './helpers/domEnv.ts'

for (const success of [true, false]) {
  test(`preview path copies the complete path and reports ${success ? 'success' : 'failure'}`, async () => {
    const { window, document } = installDomEnvironment()
    const path = '/data/项目/long-directory/AlipaySignGuide.html'
    let copied = ''
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (value: string) => { copied = value; if (!success) throw new Error('denied') },
    } })
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    try {
      await act(async () => root.render(<I18nProvider><CopyablePath path={path} /></I18nProvider>))
      const button = document.querySelector('button')!
      assert.equal(button.type, 'button')
      assert.equal(button.title, path)
      await act(async () => button.click())
      assert.equal(copied, path)
      assert.match(document.querySelector('[role="status"]')!.textContent!, success ? /已复制|Copied/ : /复制失败|Copy failed/)
      assert.ok(button.textContent!.includes(path))
      await act(async () => root.render(<I18nProvider><CopyablePath path="/new.txt" /></I18nProvider>))
      assert.equal(document.querySelector('[role="status"]')!.textContent, '')
    } finally {
      await act(async () => root.unmount())
      await window.happyDOM.close()
    }
  })
}
