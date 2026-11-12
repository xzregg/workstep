// Offline layout check: no application server required.
import '../tests/helpers/domEnv.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import MermaidPreviewDialog from '../src/components/MermaidPreviewDialog.tsx'
import { I18nProvider } from '../src/i18n/index.tsx'
import { installDomEnvironment } from '../tests/helpers/domEnv.ts'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const css = ['index.css', 'mobile.css'].map(file => fs.readFileSync(new URL('../src/' + file, import.meta.url), 'utf8')).join('\n')
try {
  for (const width of [320, 390, 1023, 1440]) {
    for (const [iw, ih] of [[1800, 800], [800, 3000]]) {
      const { window, document } = installDomEnvironment()
      window.happyDOM.setWindowSize({ width, height: 900 })
      const root = createRoot(document.body.appendChild(document.createElement('div')))
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${iw} ${ih}" style="max-width: ${iw}px;"><rect width="240" height="80" fill="#eef"/><text x="30" y="50">Flowchart preview</text></svg>`
      await act(async () => root.render(React.createElement(I18nProvider, null, React.createElement(MermaidPreviewDialog, { svg, onClose() {} }))))
      const page = await browser.newPage({ viewport: { width, height: 900 } })
      await page.setContent(`<style>${css}</style>${document.body.innerHTML}`)
      if (width <= 1023) await page.locator('.image-preview img').evaluate(img => img.decode())
      for (const selector of ['.image-preview-window', '.image-preview-close', '.image-preview-toolbar']) {
        const box = await page.locator(selector).boundingBox()
        assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= 901, `${width} ${iw}x${ih} ${selector}: ${JSON.stringify(box)}`)
      }
      const toolbar = await page.locator('.image-preview-toolbar').boundingBox()
      const content = await page.locator(width > 1023 ? '.mermaid-preview__scroll' : '.image-preview-viewport').boundingBox()
      assert.ok(content.y + content.height <= toolbar.y + 1, 'toolbar must follow diagram without covering it')
      await page.screenshot({ path: `/tmp/workstep-mermaid-preview-${width}-${iw}.png` })
      if (width > 1023) {
        const before = await page.locator('.mermaid-preview__canvas text').boundingBox()
        const nodeBefore = await page.locator('.mermaid-preview__canvas rect').boundingBox()
        const canvas = document.querySelector('.mermaid-preview__canvas')
        canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1200, height: 800 })
        await act(async () => canvas.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, clientX: 100, clientY: 50 })))
        await page.setContent(`<style>${css}</style>${document.body.innerHTML}`)
        const after = await page.locator('.mermaid-preview__canvas text').boundingBox()
        assert.ok(after.width / before.width > 1.95 && after.width / before.width < 2.1, `text must scale with zoom, got ${after.width / before.width}`)
        assert.ok(after.height / before.height > 1.95, 'text height must scale with zoom')
        const nodeAfter = await page.locator('.mermaid-preview__canvas rect').boundingBox()
        assert.ok(nodeAfter.width / nodeBefore.width > 1.95 && nodeAfter.height / nodeBefore.height > 1.95, 'node must scale with zoom')
        await page.screenshot({ path: `/tmp/workstep-mermaid-preview-${width}-${iw}-zoomed.png` })
      }
      console.log(`${width} ${iw}x${ih}: fits and scales`)
      await page.close()
      await act(async () => root.unmount())
      await window.happyDOM.close()
    }
  }
} finally { await browser.close() }
