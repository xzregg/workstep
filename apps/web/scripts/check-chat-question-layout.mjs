// Real ChatMessageBubble + production CSS, isolated data and no app server.
// Run from apps/web: rtk proxy node scripts/check-chat-question-layout.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import { chromium } from '../../desktop/node_modules/playwright-core/index.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const output = path.resolve(root, '../../tmp/mobile-message-options', process.env.CHECK_PHASE || 'current')
await fs.mkdir(output, { recursive: true })
const options = [
  '先做可玩原型，使用现有素材和程序绘图，不调用付费服务',
  '使用 AI 美术和音乐；若工具要求登录或付费，再由你完成',
  '中文长句'.repeat(30),
  '使用 WorkStep API 和 GitHub 创建 ThreeKingdomsTowerDefense 原型，确认资源与程序绘图均可正常使用',
  'ContinuousLongStringWithoutSpaces'.repeat(12),
  '短选项',
]
const input = path.join(output, 'index.html')
await fs.writeFile(input, '<html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root" class="chat-history-scroll"></div><script type="module" src="/@question-preview"></script></body></html>')
const code = `
import React from 'react'
import { createRoot } from 'react-dom/client'
import ChatMessageBubble from '/src/components/ChatMessageBubble.tsx'
import { I18nProvider } from '/src/i18n/index.tsx'
import '/src/index.css'
import '/src/mobile.css'
import '/@question-preview.css'
window.answers = []
createRoot(document.getElementById('root')).render(
  React.createElement(I18nProvider, null, React.createElement('div', {
    className: 'chat-history-content chat-history-content--assistant'
  }, React.createElement(ChatMessageBubble, {
    role: 'assistant', sender: 'Codex', initials: 'AI', color: 'var(--ai-assistant)',
    content: '这次先做哪种版本？我会先检查模板和素材服务。',
    events: [{ type: 'CUSTOM', name: 'workstep.async_question', value: {
      source_item_id: 'layout-fixture', questions: [{
        title: '这次先做哪种版本？我会先检查模板和素材服务。',
        options: ${JSON.stringify(options)}
      }]
    }}],
    onAsyncQuestionSubmit: async (answer) => { window.answers.push(answer); return true }
  })))
)
`
const built = await build({
  root: output, configFile: false, publicDir: false, logLevel: 'error',
  plugins: [{
    name: 'question-preview',
    resolveId(id) { if (id.startsWith('/@question-preview')) return '\0' + id },
    load(id) {
      if (id === '\0/@question-preview') return code
      if (id === '\0/@question-preview.css') return 'body { overflow: visible; } #root { height: auto; min-height: 100vh; }'
    },
  }],
  resolve: { alias: {
    '/src': path.join(root, 'src'),
    'react': path.join(root, 'node_modules/react'),
    'react-dom': path.join(root, 'node_modules/react-dom'),
  } },
  build: { write: false, rolldownOptions: { input } },
})
const files = new Map(built.output.map(file => ['/' + file.fileName, file]))
const html = built.output.find(file => file.fileName.endsWith('.html')).source
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
})
const results = []
const applyFontScale = async (page, scale) => {
  await page.evaluate(scale => document.documentElement.style.setProperty('--font-scale', scale), scale)
  // Global button transitions include font-size; measure the settled geometry.
  await page.waitForFunction(expected =>
    Math.abs(parseFloat(getComputedStyle(document.querySelector('.chat-async-question button')).fontSize) - expected) < 0.01,
  13 * scale)
}
try {
  for (const scale of [1, 1.3]) {
    for (const width of [320, 375, 390, 430, 1023, 1024, 1440]) {
      const page = await browser.newPage({ viewport: { width, height: 950 } })
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      await page.route('**/*', route => {
        const url = new URL(route.request().url())
        if (url.hostname !== 'questions.invalid') return route.abort()
        if (url.pathname === '/') return route.fulfill({ body: html, contentType: 'text/html' })
        const file = files.get(url.pathname)
        return file
          ? route.fulfill({ body: file.code ?? file.source, contentType: file.fileName.endsWith('.css') ? 'text/css' : 'text/javascript' })
          : route.fulfill({ status: 404, body: '' })
      })
      await page.goto('https://questions.invalid/')
      const buttons = page.locator('.chat-async-question-options button')
      await buttons.last().waitFor()
      await applyFontScale(page, scale)
      const measure = await page.evaluate(() => {
        const card = document.querySelector('.chat-async-question')
        const container = card.parentElement.getBoundingClientRect()
        const bounds = card.getBoundingClientRect()
        return {
          pageOverflow: document.documentElement.scrollWidth > innerWidth,
          cardContained: bounds.left >= container.left && bounds.right <= container.right + 1,
          buttons: [...card.querySelectorAll('button')].map(button => {
            const rect = button.getBoundingClientRect(), range = document.createRange()
            range.selectNodeContents(button)
            const lines = [...range.getClientRects()]
            return {
              contained: rect.left >= bounds.left && rect.right <= bounds.right + 1,
              unclipped: button.scrollWidth <= button.clientWidth + 1 && button.scrollHeight <= button.clientHeight + 1,
              textContained: lines.every(line => line.left >= rect.left && line.right <= rect.right + 1 && line.bottom <= rect.bottom),
              lines: lines.length, height: rect.height,
              fontSize: getComputedStyle(button).fontSize,
              fontScale: getComputedStyle(button).getPropertyValue('--font-scale'),
            }
          }),
        }
      })
      results.push({ width, scale, ...measure })
      await page.screenshot({ path: path.join(output, `questions-${width}-${scale}.png`), fullPage: true })
      await fs.writeFile(path.join(output, 'measurements.json'), JSON.stringify(results, null, 2))
      assert.equal(measure.pageOverflow, false, `${width}/${scale}: page overflow`)
      assert.equal(measure.cardContained, true, `${width}/${scale}: card overflow`)
      for (const button of measure.buttons) {
        assert.equal(button.contained && button.unclipped && button.textContained, true, `${width}/${scale}: option clipped`)
        if (width <= 1023) assert.ok(button.height >= 44, 'mobile touch area')
      }
      if (width <= 430) {
        assert.ok(measure.buttons[0].lines > 1, 'long reference option must wrap')
        // At 430px the shorter mixed-language option fits at the default font size.
        if (width <= 390 || scale > 1) assert.ok(measure.buttons[1].lines > 1, 'mixed reference option must wrap')
      }
      assert.equal(measure.buttons.at(-1).lines, 1, 'short option stays on one line')
      // Hit the last visible text line to verify the expanded click area.
      for (let index = 0; index < options.length; index++) {
        if (index) await page.reload()
        await buttons.nth(index).waitFor()
        await applyFontScale(page, scale)
        const height = await buttons.nth(index).evaluate(button => button.getBoundingClientRect().height)
        await buttons.nth(index).click({ position: { x: 20, y: height - 10 } })
        await page.waitForFunction(() => window.answers.length === 1)
        assert.equal(await page.evaluate(() => window.answers[0]), options[index])
        assert.equal(await buttons.nth(index).getAttribute('aria-pressed'), 'true')
        assert.equal(await buttons.nth(index).isDisabled(), true)
        assert.equal(await buttons.first().isDisabled(), true)
        if (!index) {
          await page.screenshot({ path: path.join(output, `selected-${width}-${scale}.png`), fullPage: true })
          // Disabled options must not submit again.
          await buttons.nth(1).dispatchEvent('click')
          assert.equal(await page.evaluate(() => window.answers.length), 1)
        }
      }
      assert.deepEqual(errors, [])
      await page.close()
    }
  }
} finally {
  await browser.close()
}
console.log(`Passed ${results.length} layouts with full option submissions. Screenshots: ${output}`)
