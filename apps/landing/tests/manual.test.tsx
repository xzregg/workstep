import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import * as manualContent from '../src/manual/content'
import { ManualPage } from '../src/manual/ManualPage'
import { manualChapters, manualGroups, getManualGroups, getManualChapterId, isManualHash } from '../src/manual/content'
import { Nav } from '../src/components/Nav'
import { I18nProvider } from '../src/i18n'

describe('operation manual', () => {
  it('categorizes every chapter exactly once, keeping SDK setup in quick start', () => {
    const ids = manualGroups.flatMap(group => group.chapterIds)
    expect([...ids].sort()).toEqual(manualChapters.map(chapter => chapter.id).sort())
    expect(manualGroups.find(group => group.id === 'getting-started')?.chapterIds).toContain('sdk-installation')
  })
  it('searches chapter content across categories without empty groups', () => {
    const groups = getManualGroups('  SDK  ')
    expect(groups.length).toBeGreaterThan(1)
    expect(groups.every(group => group.chapters.length > 0)).toBe(true)
    expect(groups.flatMap(group => group.chapters).some(chapter => chapter.id === 'sdk-installation')).toBe(true)
    expect(getManualGroups('不存在的手册词条12345')).toEqual([])
  })
  it('opens only the current category and highlights deep-linked chapters', () => {
    const html = renderToStaticMarkup(<I18nProvider><ManualPage chapterId="appearance" /></I18nProvider>)
    expect(html).toContain('对话与个性化')
    expect(html.match(/class="manual-group-toggle"[^>]*aria-expanded="true"/g)).toHaveLength(1)
    expect(html).toContain('href="#docs/appearance" aria-current="page"')
    expect(html).not.toContain('href="#docs/sdk-installation"')
  })
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
