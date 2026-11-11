// Actual shared composer rendered offline; no application service is started.
import '../tests/helpers/domEnv.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from '../tests/helpers/domEnv.ts'
import { I18nProvider } from '../src/i18n/index.tsx'
import ChatInput from '../src/components/ChatInput.tsx'
import { connectorApi } from '../src/api/connectors.ts'

const { chromium } = await import('../../desktop/node_modules/playwright-core/index.mjs')
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const css = ['index.css', 'mobile.css', 'components/connectors/Connectors.css', 'components/role-center/ChatRoleBinding.css', 'components/ComposerContextChip.css'].map(file => fs.readFileSync(new URL('../src/' + file, import.meta.url), 'utf8')).join('\n')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workstep-composer-context-'))
globalThis.fetch = async () => Response.json({ enabled: false })
connectorApi.available = async () => ({ connectors: ['GitHub', 'Figma', '很长的连接器名称用于验证省略和移除按钮始终可见'].map((name, index) => ({ id: String(index), name, kind: 'mcp', selected: true, available: true })) })
try {
  for (const [width, height] of [[320, 640], [390, 844], [1023, 768], [1280, 900]]) {
    for (const mode of ['empty', 'text', 'multiline']) {
      const { window } = installDomEnvironment()
      window.happyDOM.setWindowSize({ width, height })
      const draft = mode === 'empty' ? '' : mode === 'text' ? '帮我查询这个项目的需求' : '帮我查询这个项目的需求\n整理成文档'
      window.localStorage.setItem('workstep-chat-draft:layout', draft)
      const root = createRoot(document.body.appendChild(document.createElement('div')))
      await act(async () => root.render(React.createElement(I18nProvider, null, React.createElement(ChatInput, {
        projectId: 'demo', sessionId: 'layout', connectorsEnabled: true, value: draft, onChange() {}, onSend() {},
        roleBinding: { name: '产品专家', missing: false, loading: false, disabled: false, error: '', onOpen() {}, onRemove() {}, onRetry() {} },
      }))))
      const page = await browser.newPage({ viewport: { width, height } })
      await page.setContent('<style>' + css + '\nbody{margin:0;padding:16px}.chat-input{width:100%;max-width:720px}</style>' + document.body.innerHTML)
      // Happy DOM has no text layout; repeat the component's resize in Chromium.
      await page.locator('textarea').evaluate(element => {
        element.style.height = 'auto'
        element.style.height = element.scrollHeight + 'px'
      })
      const result = await page.evaluate(() => {
        const editor = document.querySelector('.chat-input-editor').getBoundingClientRect()
        const chips = [...document.querySelectorAll('.composer-context-chip')].map(element => {
          const box = element.getBoundingClientRect(), remove = element.querySelector('button:last-child').getBoundingClientRect()
          return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, removeRight: remove.right, removeWidth: remove.width }
        })
        const textarea = document.querySelector('textarea').getBoundingClientRect()
        return { overflow: document.body.scrollWidth > innerWidth, editor: { left: editor.left, right: editor.right, bottom: editor.bottom }, chips, textarea: { top: textarea.top, left: textarea.left, right: textarea.right, bottom: textarea.bottom } }
      })
      assert.equal(result.overflow, false, width + mode + ' no page overflow')
      assert.equal(result.chips.length, 4)
      for (const chip of result.chips) {
        assert.ok(chip.left >= result.editor.left && chip.right <= result.editor.right + 1, 'chip fits editor')
        assert.ok(chip.removeRight <= chip.right + 1 && chip.removeWidth >= 24, 'remove button stays visible')
      }
      assert.ok(result.textarea.right <= result.editor.right + 1, 'text fits editor')
      assert.ok(result.textarea.bottom <= result.editor.bottom + 1, width + ' ' + mode + ' short draft remains fully visible: ' + JSON.stringify(result))
      await page.screenshot({ path: path.join(directory, mode + '-' + width + '.png') })
      await page.close()
      await act(async () => root.unmount())
      await window.happyDOM.close()
      console.log(width + ' ' + mode + ': fits')
    }
  }
  console.log('Screenshots: ' + directory)
} finally { await browser.close() }
