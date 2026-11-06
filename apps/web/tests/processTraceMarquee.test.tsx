import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ProcessTrace from '../src/components/ProcessTrace'
import { I18nProvider } from '../src/i18n'
import { readFileSync } from 'node:fs'

for (const { width, overflow, reduced } of [
  { width: 320, overflow: true, reduced: false },
  { width: 390, overflow: true, reduced: false },
  { width: 1023, overflow: false, reduced: false },
  { width: 390, overflow: true, reduced: true },
  { width: 1280, overflow: true, reduced: false },
]) {
  test(`process status marquee: width=${width}, overflow=${overflow}, reduced=${reduced}`, async () => {
    const { window } = installDomEnvironment()
    window.innerWidth = width
    const originalMatchMedia = window.matchMedia.bind(window)
    window.matchMedia = (query: string) => {
      const media = originalMatchMedia(query)
      if (query.includes('prefers-reduced-motion')) {
        Object.defineProperty(media, 'matches', { value: reduced })
      }
      return media
    }
    const prototype = window.HTMLElement.prototype
    const scrollDescriptor = Object.getOwnPropertyDescriptor(prototype, 'scrollWidth')
    const clientDescriptor = Object.getOwnPropertyDescriptor(prototype, 'clientWidth')
    Object.defineProperty(prototype, 'scrollWidth', { configurable: true, get: () => overflow ? 300 : 50 })
    Object.defineProperty(prototype, 'clientWidth', { configurable: true, get: () => 90 })
    const container = document.body.appendChild(document.createElement('div'))
    const root = createRoot(container)
    try {
      await act(async () => root.render(<I18nProvider><ProcessTrace
        events={[]} compact stopped
        startedAt="2026-11-06T07:00:00Z" endedAt="2026-11-06T10:31:31Z"
        summaryMeta={<span data-meta>已压缩 · 会话 ID · 提示词 · 今天 07:43:30</span>}
      /></I18nProvider>))
      const marquee = container.querySelector('.process-trace-session-summary .ws-marquee')
      if (width <= 1023) {
        assert.ok(marquee, 'mobile status uses the shared marquee')
        assert.match(marquee.textContent ?? '', /停止|Stopped/)
        assert.equal(marquee.classList.contains('is-marquee'), overflow && !reduced)
        assert.equal(marquee.querySelector('[data-meta]'), null, 'right metadata stays outside the scroll area')
      } else {
        assert.equal(marquee, null, 'desktop status keeps its existing presentation')
      }
      const summary = container.querySelector<HTMLElement>('.process-trace-session-summary')!
      assert.match(summary.textContent ?? '', /会话 ID/)
      await act(async () => summary.click())
      assert.equal(summary.getAttribute('aria-expanded'), 'true')
      const styles = document.createElement('style')
      styles.textContent = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
      document.head.append(styles)
      for (const skinColor of ['rgb(160, 180, 200)', 'rgb(60, 75, 90)']) {
        container.style.setProperty('--muted', skinColor)
        await act(async () => root.render(<I18nProvider key={skinColor}><ProcessTrace
          events={[]} compact running startedAt={Date.now() - 210000}
          summaryMeta={<span data-meta>提示词 · 今天 07:43:30</span>}
        /></I18nProvider>))
        const status = container.querySelector<HTMLElement>('.process-trace-status')!
        assert.match(status.textContent ?? '', /处理中|Processing/)
        assert.equal(getComputedStyle(status).color, skinColor, 'running text keeps the skin color instead of inheriting transparent fill')
        assert.equal(getComputedStyle(status).backgroundImage, 'none')
      }
    } finally {
      await act(async () => root.unmount())
      if (scrollDescriptor) Object.defineProperty(prototype, 'scrollWidth', scrollDescriptor)
      else delete (prototype as any).scrollWidth
      if (clientDescriptor) Object.defineProperty(prototype, 'clientWidth', clientDescriptor)
      else delete (prototype as any).clientWidth
      container.remove()
      await window.happyDOM.close()
    }
  })
}
