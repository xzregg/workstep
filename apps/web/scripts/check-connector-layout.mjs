// Render actual connector components without starting the application service.
import '../tests/helpers/domEnv.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from '../tests/helpers/domEnv.ts'
import { I18nProvider, useLocaleStore } from '../src/i18n/index.tsx'
import ConnectorPicker from '../src/components/connectors/ConnectorPicker.tsx'
import ConnectorEditor from '../src/components/connectors/ConnectorEditor.tsx'
import { useProjectStore } from '../src/stores/projectStore.ts'
import { connectorApi } from '../src/api/connectors.ts'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '../../desktop/node_modules/playwright-core/index.mjs')
const browser = await chromium.launch({ executablePath: process.env.CHROME_BINARY || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const css = ['index.css', 'mobile.css', 'components/connectors/Connectors.css', 'components/connectors/ConnectorTestPanel.css', 'components/ConfirmDialog.css'].map(file => fs.readFileSync(new URL('../src/' + file, import.meta.url), 'utf8')).join('\n') + '\n' + fs.readFileSync(new URL('../../../packages/gateway-ui/src/SearchableSelect.css', import.meta.url), 'utf8')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workstep-connector-layout-'))
try {
  for (const [width, height] of [[320, 640], [390, 844], [1023, 768], [1280, 900]]) {
    for (const mode of ['picker', 'editor', 'editor-local', 'editor-test', 'editor-auth']) {
      const { window, document } = installDomEnvironment()
      window.happyDOM.setWindowSize({ width, height })
      globalThis.history = window.history
      useLocaleStore.setState({ locale: 'zh-CN' })
      useProjectStore.setState({ projects: [{ id: 'demo', name: '演示项目' }] })
      const host = document.body.appendChild(document.createElement('div'))
      host.className = 'layout-probe'
      const root = createRoot(host)
      const props = { projectId: 'demo', sessionId: 'demo', engineId: 'codex', onClose() {}, initialItems: Array.from({ length: 12 }, (_, index) => ({ id: String(index), name: ['GitHub', 'Figma', '钉钉 CLI'][index % 3], description: '读取文件、查询内容与执行已授权操作，这是较长的示例描述', kind: 'mcp', selected: index === 0, available: index !== 1 })) }
      const diagnostic = mode === 'editor-test' || mode === 'editor-auth'
      connectorApi.diagnose = async () => mode === 'editor-auth'
        ? { ok: false, status: 'auth_required', tool_count: 0, tools: [], message: '需要认证或凭据已过期，请配置认证后重试' }
        : { ok: true, status: 'connected', tool_count: 3, message: '已连接 MCP 服务', tools: ['echo', 'add', 'get_demo_info'].map(name => ({ name, description: '本地测试工具，支持查看参数和手动执行', input_schema: { type: 'object', properties: { text: { type: 'string' } } } })) }
      await act(async () => root.render(React.createElement(I18nProvider, null, mode === 'picker' ? React.createElement(ConnectorPicker, props) : React.createElement(ConnectorEditor, { initialTab: diagnostic ? 'test' : 'config', initial: mode === 'editor-local' ? { name: '本地工具', kind: 'mcp', transport: 'stdio', command: 'npx', args: ['-y', 'example-server', '/path/to/project with spaces'] } : diagnostic ? { name: 'MCP 测试服务', url: 'https://example.com/mcp' } : {}, onClose() {}, onSaved() {} }))))
      if (diagnostic) await act(async () => document.querySelector('[data-connector-diagnose]').click())
      const page = await browser.newPage({ viewport: { width, height } })
      await page.setContent('<style>' + css + '\n.layout-probe{position:fixed;bottom:50px;left:20px} body{margin:0;--mobile-button-height:32px}</style>' + document.body.innerHTML)
      const result = await page.evaluate(mode => {
        const box = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, height: r.height } }
        return mode === 'picker' ? { surface: box('[role=dialog]'), footer: box('.connector-picker-footer'), list: box('.connector-picker-list'), bodyOverflow: document.body.scrollWidth > innerWidth } : { surface: box('[role=dialog]'), bodyOverflow: document.body.scrollWidth > innerWidth }
      }, mode)
      assert.ok(!result.bodyOverflow, 'no horizontal page overflow: ' + width + mode)
      for (const [name, box] of Object.entries(result).filter(([name]) => name !== 'bodyOverflow')) {
        assert.ok(box.left >= -1 && box.right <= width + 1 && box.top >= -1 && box.bottom <= height + 1, width + ' ' + mode + ' ' + name + ': ' + JSON.stringify(box))
      }
      if (mode === 'picker') {
        assert.ok(result.list.bottom <= result.footer.top + 1, 'list does not cover footer')
        assert.ok(await page.locator('.connector-picker-list').evaluate(element => element.scrollHeight > element.clientHeight), 'long list scrolls')
      }
      await page.screenshot({ path: path.join(directory, mode + '-' + width + '.png') })
      await page.close()
      await act(async () => root.unmount())
      await window.happyDOM.close()
      console.log(mode + ' ' + width + ': fits')
    }
  }
  console.log('Screenshots: ' + directory)
} finally { await browser.close() }
