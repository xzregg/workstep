import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import * as manualContent from '../src/manual/content'
import { ManualPage } from '../src/manual/ManualPage'
import { manualChapters, getManualChapterId, isManualHash } from '../src/manual/content'
import { Nav } from '../src/components/Nav'
import { I18nProvider } from '../src/i18n'

describe('operation manual', () => {
  it('shows a clear notice when a declared screenshot is still missing', () => {
    const screenshot = vi.spyOn(manualContent, 'screenshotUrl').mockReturnValue(undefined)
    try {
      const html = renderToStaticMarkup(<I18nProvider><ManualPage chapterId="sdk-installation" /></I18nProvider>)
      expect(html).toContain('本节界面截图待补充')
      expect(html).not.toContain('<img')
    } finally {
      screenshot.mockRestore()
    }
  })
  it('supports shareable chapters without server routing', () => {
    expect(isManualHash('#docs')).toBe(true)
    expect(isManualHash('#docs/sdk')).toBe(true)
    expect(isManualHash('#features')).toBe(false)
    expect(getManualChapterId('#docs/unknown')).toBe(manualChapters[0].id)
  })
  it('exposes the docs link among controls visible on mobile', () => {
    const html = renderToStaticMarkup(<I18nProvider><Nav /></I18nProvider>)
    expect(html).toContain('href="#docs" class="nav-control nav-docs"')
  })
  it('renders the real SDK installation screenshot', () => {
    const html = renderToStaticMarkup(<I18nProvider><ManualPage chapterId="sdk-installation" /></I18nProvider>)
    expect(html).toContain('alt="SDK 引擎安装与版本选择界面"')
    expect(html).toContain('sdk-install-version.jpg')
    expect(html).toContain('loading="lazy"')
  })
  it('keeps chapter and screenshot identifiers unique', () => {
    expect(new Set(manualChapters.map(c => c.id)).size).toBe(manualChapters.length)
    const ids = manualChapters.flatMap(c => c.sections.flatMap(s => s.screenshot ? [s.screenshot.id] : []))
    expect(new Set(ids).size).toBe(ids.length)
    expect(manualChapters.every(c => c.sections.length > 0 && c.sections.every(s => s.steps.length > 0))).toBe(true)
  })
  it('renders navigation, actionable steps and SDK-first guidance', () => {
    const html = renderToStaticMarkup(<I18nProvider><ManualPage chapterId={manualChapters[0].id} /></I18nProvider>)
    expect(html).toContain('操作手册')
    expect(html).toContain('SDK')
    expect(html).toContain('href="#docs/')
    expect(html).toContain('<ol')
    expect(html).not.toContain('src="undefined"')
  })
})
