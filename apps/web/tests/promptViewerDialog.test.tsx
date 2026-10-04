import './helpers/domEnv.ts'

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import PromptViewerDialog from '../src/components/PromptViewerDialog.tsx'
import { I18nProvider } from '../src/i18n/index.tsx'
import { installDomEnvironment } from './helpers/domEnv.ts'

for (const width of [390, 1280]) {
  test(`prompt viewer preserves newlines and wraps long input at ${width}px`, async () => {
    const { window, document } = installDomEnvironment()
    window.innerWidth = width
    const style = document.createElement('style')
    style.textContent = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
      + readFileSync(new URL('../src/mobile.css', import.meta.url), 'utf8')
    document.head.appendChild(style)
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    const body = '第一段用户原文。'.repeat(20) + '\n第二段保持换行。\n' + 'long-unbroken-input'.repeat(30)
    try {
      await act(async () => root.render(
        <I18nProvider>
          <PromptViewerDialog prompt={`### 正文（user）\n\n\`\`\`text\n${body}\n\`\`\``} onClose={() => {}} />
        </I18nProvider>,
      ))
      const code = document.querySelector('.prompt-viewer-markdown pre code')!
      assert.equal(code.textContent, body + '\n')
      const computed = window.getComputedStyle(code)
      assert.equal(computed.whiteSpace, 'pre-wrap')
      assert.equal(computed.overflowWrap, 'anywhere')
      assert.equal(computed.width, '100%')

      const normal = document.createElement('div')
      normal.className = 'markdown-message'
      normal.innerHTML = '<pre><code>normal code</code></pre>'
      document.body.appendChild(normal)
      assert.equal(window.getComputedStyle(normal.querySelector('code')!).whiteSpace, 'pre')
    } finally {
      await act(async () => root.unmount())
      await window.happyDOM.close()
    }
  })
}
