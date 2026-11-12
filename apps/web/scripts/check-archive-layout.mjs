// Render the real archive component offline without starting application services.
import '../tests/helpers/domEnv.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from '../tests/helpers/domEnv.ts'
import { I18nProvider, useLocaleStore } from '../src/i18n/index.tsx'
import { ArchivedChatSessionsDialog } from '../src/components/ArchivedChatSessions.tsx'
import { chatSessionApi } from '../src/api/client.ts'

const { chromium } = await import('../../desktop/node_modules/playwright-core/index.mjs')
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const { window } = installDomEnvironment()
useLocaleStore.setState({ locale: 'zh-CN' })
chatSessionApi.list = async () => ({ sessions: [false, true].map((channel, index) => ({
  id: String(index), title: '移动端归档列表长标题应当显示更多内容并保留完整的归档时间',
  archived_at: '2026-11-11T13:26:00Z', preview: '这是最后一条回复摘要，用于验证文字不会与时间重叠。',
  source: channel ? 'channel' : 'chat', channel_platform: 'wecom',
})) })
const root = createRoot(document.body.appendChild(document.createElement('div')))
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workstep-archive-'))
try {
  await act(async () => root.render(React.createElement(I18nProvider, null,
    React.createElement(ArchivedChatSessionsDialog, { projectId: 'demo', projectName: '操作手册演示', onClose() {} }))))
  const css = ['index.css', 'mobile.css', 'components/ArchivedChatSessions.css', 'components/ChatSessionSourceBadge.css']
    .map(file => fs.readFileSync(new URL('../src/' + file, import.meta.url), 'utf8')).join('\n')
  for (const width of [320, 390, 1023, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 844 } })
    await page.setContent('<style>' + css + '</style>' + document.body.innerHTML)
    if (width <= 1023) {
      const toolbar = await page.locator('.archived-session-toolbar').evaluate(element => {
        const boxes = [...element.children].map(child => child.getBoundingClientRect())
        return { sameLine: boxes.every(box => box.top < boxes[0].bottom && box.bottom > boxes[0].top),
          overflow: element.scrollWidth > element.clientWidth }
      })
      assert.ok(toolbar.sameLine, 'select all and bulk actions stay on one line')
      assert.equal(toolbar.overflow, false, 'bulk toolbar fits narrow screens')
      const gap = await page.locator('.archived-session-row').first().evaluate(element => parseFloat(getComputedStyle(element).rowGap))
      assert.ok(gap <= 4, 'summary and footer use a compact gap')
    }
    const badge = page.locator('.archived-session-actions .chat-session-source-badge')
    assert.equal(await badge.count(), 1, 'source badge shares the actions row')
    const sameLine = await badge.evaluate(element => {
      const badgeBox = element.getBoundingClientRect()
      const summaryBox = element.closest('.archived-session-actions').querySelector('button').getBoundingClientRect()
      return badgeBox.top < summaryBox.bottom && summaryBox.top < badgeBox.bottom
    })
    assert.ok(sameLine, 'badge must not add a separate line')
    const rows = await page.locator('.archived-session-row').evaluateAll(elements => elements.map(row => {
      const title = row.querySelector('.archived-session-title'), time = row.querySelector('.archived-session-time')
      const box = row.getBoundingClientRect(), titleBox = title.getBoundingClientRect(), timeBox = time.getBoundingClientRect()
      const actions = row.querySelector('.archived-session-actions').getBoundingClientRect()
      return { titleHeight: titleBox.height, titleLineHeight: parseFloat(getComputedStyle(title).lineHeight), actionTop: actions.top, actionBottom: actions.bottom, timeLeft: timeBox.left, timeBottom: timeBox.bottom, overflow: row.scrollWidth > row.clientWidth, titleWidth: titleBox.width, rowWidth: box.width,
        titleBottom: titleBox.bottom, timeTop: timeBox.top, timeRight: timeBox.right, right: box.right,
        timeClipped: time.scrollWidth > time.clientWidth }
    }))
    for (const row of rows) {
      assert.equal(row.overflow, false, width + ': row must not overflow')
      assert.equal(row.timeClipped, false, width + ': full time is visible')
      assert.ok(row.timeRight <= row.right, width + ': time fits row')
      if (width <= 1023) {
        assert.ok(row.titleHeight <= row.titleLineHeight + 1, 'mobile title stays on one line')
        assert.ok(row.titleWidth > row.rowWidth * .75, width + ': title gets most of the row ' + JSON.stringify(row))
        assert.ok(row.timeTop >= row.titleBottom, width + ': time is below title')
        assert.ok(row.timeTop < row.actionBottom && row.timeBottom > row.actionTop, width + ': time and actions share a row')
      }
    }
    if (width > 1023) assert.equal(rows[0].timeLeft, rows[1].timeLeft, 'desktop timestamps align across sources')
    await page.screenshot({ path: path.join(directory, width + '.png') })
    await page.close()
    console.log(width + ': archive layout fits')
  }
  console.log('Screenshots: ' + directory)
} finally {
  await act(async () => root.unmount())
  await window.happyDOM.close()
  await browser.close()
}
