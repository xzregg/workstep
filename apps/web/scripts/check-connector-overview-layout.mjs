// Render actual settings components with isolated example data, without a daemon.
import '../tests/helpers/domEnv.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from '../tests/helpers/domEnv.ts'
import { I18nProvider, useLocaleStore } from '../src/i18n/index.tsx'
import { connectorApi } from '../src/api/connectors.ts'
import ConnectorSettingsPanel from '../src/components/connectors/ConnectorSettingsPanel.tsx'
import SettingsNavigation from '../src/components/SettingsNavigation.tsx'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '../../desktop/node_modules/playwright-core/index.mjs')
const browser = await chromium.launch({ executablePath: process.env.CHROME_BINARY || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const css = ['index.css', 'components/SettingsNavigation.css', 'pages/SettingsPage.css', 'mobile.css', 'components/connectors/Connectors.css'].map(file => fs.readFileSync(new URL('../src/' + file, import.meta.url), 'utf8')).join('\n')
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workstep-connector-overview-'))
const items = ['GitHub CLI', '设计工具 MCP', '钉钉 CLI'].map((name, index) => ({ id: String(index), name, kind: index === 1 ? 'mcp' : 'cli', transport: index === 1 ? 'http' : 'stdio', description: ['让代码、Issue 和 Pull Request 成为工作流的一部分。', '读取设计文件，将设计上下文带入任务。', '通过钉钉 CLI 访问已授权的文档、日程与工作信息。'][index], enabled: true, project_ids: index === 2 ? [] : ['demo'], args: [], command: 'demo', url: '', revision: 1, header_names: [], env_names: [], has_credentials: false }))
try {
  for (const [width, height] of [[320, 740], [390, 844], [1023, 768], [1085, 800], [1440, 1000]]) {
    for (const mode of ['added', 'empty', 'browse', 'local']) {
      const { window, document } = installDomEnvironment()
      window.happyDOM.setWindowSize({ width, height })
      globalThis.history = window.history
      useLocaleStore.setState({ locale: 'zh-CN' })
      connectorApi.list = async () => ({ connectors: mode === 'empty' ? [] : items })
      connectorApi.scan = async () => ({ items: ['node_repl', 'computer-use', '钉钉 CLI', 'GitHub CLI'].map((name, index) => ({ id: String(index), name, source: index < 2 ? '~/.codex/config.toml' : '/usr/local/bin/' + (index === 2 ? 'dws' : 'gh'), command: 'demo', kind: index < 2 ? 'mcp' : 'cli', transport: 'stdio', requires_credentials: true })) })
      const host = document.body.appendChild(document.createElement('div'))
      host.className = 'settings-dialog-panel overview-layout-probe'
      const root = createRoot(host)
      await act(async () => root.render(React.createElement(I18nProvider, null, React.createElement('div', { className: 'settings-layout' }, React.createElement(SettingsNavigation, { activeSection: 'connectors', onSelect() {} }), React.createElement('section', { className: 'settings-content' }, React.createElement(ConnectorSettingsPanel))))))
      if (mode === 'browse') await act(async () => document.querySelector('#connector-tab-browse').click())
      if (mode === 'local') await act(async () => document.querySelector('.connector-header-actions > button').click())
      const page = await browser.newPage({ viewport: { width, height } })
      await page.setContent('<style>' + css + '\nbody{margin:0;--mobile-button-height:32px}.overview-layout-probe{height:100dvh;display:flex;flex-direction:column}.overview-layout-probe .settings-layout{min-height:0}</style>' + document.body.innerHTML)
      const buttonStyles = await page.evaluate(() => {
        const reference = document.createElement('button')
        reference.className = 'btn btn-primary'
        document.body.append(reference)
        const properties = ['backgroundColor', 'color', 'borderRadius', 'fontSize', 'paddingTop', 'paddingRight']
        const read = element => Object.fromEntries(properties.map(key => [key, getComputedStyle(element)[key]]))
        const result = { actual: read(document.querySelector('.connector-header-actions .btn-primary')), reference: read(reference), tabRadius: getComputedStyle(document.querySelector('.connector-tabs > button')).borderRadius }
        reference.remove()
        return result
      })
      assert.deepEqual(buttonStyles.actual, buttonStyles.reference, 'connector primary button follows shared system style')
      assert.notEqual(buttonStyles.tabRadius, '0px', 'tab focus follows rounded system controls')
      const result = await page.evaluate(() => {
        const content = document.querySelector('.settings-content'), rect = content.getBoundingClientRect()
        return { pageOverflow: document.documentElement.scrollWidth > innerWidth, contentOverflow: content.scrollWidth > content.clientWidth + 1, rect: { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }, cards: [...document.querySelectorAll('.connector-card')].map(element => { const r = element.getBoundingClientRect(); return { left: r.left, right: r.right } }) }
      })
      assert.ok(!result.pageOverflow && !result.contentOverflow, width + ' ' + mode + ': no horizontal overflow ' + JSON.stringify(result))
      assert.ok(result.rect.left >= -1 && result.rect.right <= width + 1, width + ' content stays in viewport')
      for (const rect of result.cards) assert.ok(rect.left >= result.rect.left - 1 && rect.right <= result.rect.right + 1, width + ' card stays in content')
      await page.screenshot({ path: path.join(directory, mode + '-' + width + '.png') })
      await page.close()
      await act(async () => root.unmount())
      await window.happyDOM.close()
      console.log(mode + ' ' + width + ': fits')
    }
  }
  console.log('Screenshots: ' + directory)
} finally { await browser.close() }
