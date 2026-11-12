// Render the actual component in Chrome without starting an application server.
// PLAYWRIGHT_MODULE may point to an existing Playwright installation.
import '../tests/helpers/domEnv.ts'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import ImagePreview from '../src/components/ImagePreview.tsx'
import { I18nProvider, useLocaleStore } from '../src/i18n/index.tsx'
import { installDomEnvironment } from '../tests/helpers/domEnv.ts'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright')
const browser = await chromium.launch({ executablePath: process.env.CHROME_BINARY || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
const css = ['index.css', 'mobile.css'].map(file => fs.readFileSync(new URL('../src/' + file, import.meta.url), 'utf8')).join('\n')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'image-preview-layout-'))
try {
  for (const [width, height] of [[320, 640], [390, 844], [844, 390], [1023, 768], [1440, 900]]) {
    for (const [iw, ih] of [[1600, 900], [900, 3000], [4000, 300], [64, 64]]) {
      const { window, document } = installDomEnvironment()
      window.happyDOM.setWindowSize({ width, height })
      const host = document.body.appendChild(document.createElement('div'))
      host.className = 'transformed-message'
      useLocaleStore.getState().setLocale('zh-CN')
      const root = createRoot(host)
      const src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="' + iw + '" height="' + ih + '"><rect width="100%" height="100%" fill="#245da8"/></svg>')
      await act(async () => root.render(React.createElement(I18nProvider, null, React.createElement(ImagePreview, { src, onClose() {} }))))
      const page = await browser.newPage({ viewport: { width, height } })
      await page.setContent('<style>' + css + '\n:root{--mobile-button-height:32px;--font-scale:1;--bg-2:#303030;--text-primary:#fff} .transformed-message{transform:translateZ(0);width:240px;height:160px;overflow:hidden} </style>' + document.body.innerHTML)
      await page.evaluate(() => { document.documentElement.dataset.skinId = 'preview-regression' })
      await page.addStyleTag({ content: 'html[data-skin-id="preview-regression"] .resizable-panel, html[data-skin-id="preview-regression"] .image-preview-header { background: #f6faed !important; border: 1px solid white; box-shadow: 0 20px 64px #0008; }' })
      await page.addStyleTag({ content: 'html[data-skin-id="preview-regression"] button { background: transparent !important; color: #163b32 !important; border-radius: 4px !important; }' })
      await page.locator('.image-preview img').evaluate(img => img.decode())
      const closeStyle = await page.locator('.image-preview-close').evaluate(el => {
        const style = getComputedStyle(el)
        return { background: style.backgroundColor, color: style.color, radius: style.borderRadius }
      })
      assert.equal(closeStyle.background, 'rgb(48, 48, 48)')
      assert.equal(closeStyle.color, 'rgb(255, 255, 255)')
      assert.equal(closeStyle.radius, '50%')
      const glyph = await page.locator('.image-preview-close circle').evaluate(el => ({ fill: getComputedStyle(el).fill, radius: el.getAttribute('r') }))
      assert.equal(glyph.fill, 'rgb(48, 48, 48)', 'circle must be drawn independently of button background')
      assert.equal(glyph.radius, '16')
      const surface = await page.locator('.image-preview-window').evaluate(el => {
        const style = getComputedStyle(el)
        return { background: style.backgroundColor, border: style.borderTopWidth, shadow: style.boxShadow }
      })
      assert.equal(surface.background, 'rgba(0, 0, 0, 0)', 'skin must not paint behind the close row')
      assert.equal(surface.border, '0px')
      assert.equal(surface.shadow, 'none')
      const result = await page.evaluate(() => {
        const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { left:r.left, right:r.right, top:r.top, bottom:r.bottom, width:r.width, height:r.height } }
        return { overlay:rect('.image-preview'), panel:rect('.image-preview-window'), image:rect('.image-preview img'), close:rect('.image-preview-close'), toolbar:rect('.image-preview-toolbar') }
      })
      assert.equal(result.overlay.width, width)
      assert.equal(result.overlay.height, height)
      const label = width + 'x' + height + ' image ' + iw + 'x' + ih
      for (const [name, r] of Object.entries(result)) {
        assert.ok(r.left >= -1 && r.right <= width + 1 && r.top >= -1 && r.bottom <= height + 1, label + ': ' + name + ' outside viewport ' + JSON.stringify(r))
      }
      const centerTop = width <= 1023 ? result.close.top : result.panel.top
      assert.ok(Math.abs((centerTop + result.toolbar.bottom) / 2 - height / 2) <= 2, label + ': whole preview must be centered')
      assert.ok(result.close.bottom <= result.image.top, label + ': close must not cover image')
      assert.ok(result.image.bottom <= result.toolbar.top + 1, label + ': toolbar must not cover image')
      await page.screenshot({ path:path.join(dir, width + '-' + iw + 'x' + ih + '.png') })
      if (width > 1023) {
        const image = document.querySelector('.desktop-image-preview img')
        image.getBoundingClientRect = () => ({ width: result.image.width, height: result.image.height })
        await act(async () => image.dispatchEvent(new window.Event('load')))
        await act(async () => image.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, clientX: 0, clientY: 0 })))
        await page.setContent('<style>' + css + '</style>' + document.body.innerHTML)
        await page.locator('.desktop-image-preview img').evaluate(img => img.decode())
        const zoomed = await page.locator('.desktop-image-preview').evaluate(el => ({ width: el.clientWidth, height: el.clientHeight, scrollWidth: el.scrollWidth, scrollHeight: el.scrollHeight }))
        assert.ok(zoomed.scrollWidth > zoomed.width && zoomed.scrollHeight > zoomed.height, 'zoomed image must be scrollable in both directions')
        const toolbar = await page.locator('.image-preview-toolbar').boundingBox()
        assert.ok(toolbar.y + toolbar.height <= height + 1, 'zoomed image must not push toolbar outside viewport')
        await page.screenshot({ path:path.join(dir, width + '-' + iw + 'x' + ih + '-zoomed.png') })
      }
      await page.close()
      await act(async () => root.unmount())
      await window.happyDOM.close()
      console.log(label + ': fits and centered')
    }
  }
  console.log('Screenshots: ' + dir)
} finally { await browser.close() }
