import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Nav } from '../src/components/Nav'
import { Hero } from '../src/components/Hero'
import { CanvasScene } from '../src/scenes/CanvasScene'
import { I18nProvider } from '../src/i18n'
import { ManualPage } from '../src/manual/ManualPage'
import { getManualChapters, getManualGroups, manualChapters } from '../src/manual/content'
import type { Lang } from '../src/i18n'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

afterEach(() => vi.unstubAllGlobals())

describe('builtin language selection', () => {
  for (const lang of ['zh-CN', 'en-US', 'fr-FR', 'de-DE', 'ar'] as const) {
    it(`documents the desktop conversation workspace in ${lang}`, () => {
      const chapter = getManualChapters(lang).find(chapter => chapter.id === 'chat-skills')!
      const section = chapter.sections.find(section => section.screenshot?.id === 'chat-workspace')!
      expect(section).toBeDefined()
      expect(section.steps.length).toBeGreaterThanOrEqual(4)
      expect(section.steps.join(' ')).toContain('4')
      expect(section.tips?.length).toBeGreaterThanOrEqual(2)
    })
  }
  for (const lang of ['zh-CN', 'en-US', 'fr-FR', 'de-DE', 'ar'] as const) {
    it(`documents QQ setup and OpenID binding in ${lang}`, () => {
      const chapter = getManualChapters(lang).find(chapter => chapter.id === 'bots')!
      expect(chapter.summary).toContain('QQ')
      const setup = chapter.sections[0].steps.find(step => step.includes('QQ'))!
      expect(setup).toContain('App ID')
      expect(setup).toContain('App Secret')
      expect(setup).toContain('group_openid')
      expect(chapter.sections[0].tips.join(' ')).toContain('QQ')
    })
  }
  it('translates the homepage canvas artifact label', () => {
    vi.stubGlobal('window', { localStorage: { getItem: () => 'en-US' } })
    const html = renderToStaticMarkup(<I18nProvider><CanvasScene time={6500} /></I18nProvider>)
    expect(html).toContain('Artifact list')
    expect(html).not.toContain('产物清单')
  })
  it('requires a translation review when the Chinese manual changes', () => {
    const fingerprint = readFileSync(new URL('../src/manual/locales/source.sha256', import.meta.url), 'utf8').trim()
    expect(createHash('sha256').update(JSON.stringify(manualChapters)).digest('hex')).toBe(fingerprint)
  })
  for (const [locale, action, label] of [
    ['fr-FR', 'Télécharger l’application', 'Français'],
    ['de-DE', 'Desktop-App herunterladen', 'Deutsch'],
    ['ar', 'تنزيل تطبيق سطح المكتب', 'العربية'],
  ]) {
    it(`renders the saved ${locale} language and all language options`, () => {
      vi.stubGlobal('window', {
        localStorage: { getItem: (key: string) => key === 'workstep-landing-lang' ? locale : null },
        navigator: { language: 'zh-CN' },
        matchMedia: () => ({ matches: false }),
      })
      const html = renderToStaticMarkup(<I18nProvider><Nav /><Hero onOpenDemos={() => {}} experienceHref="#download" /><ManualPage chapterId="sdk-installation" /></I18nProvider>)
      expect(html).toContain(action)
      expect(html).toContain(`<option value="${locale}" selected="">${label}</option>`)
      for (const language of ['zh-CN', 'en-US', 'fr-FR', 'de-DE', 'ar']) expect(html).toContain(`value="${language}"`)
      expect(html).toContain('class="manual-language-note"')
      expect(html).toContain(`lang="${locale}"`)
      expect(html).toContain(getManualChapters(locale as Lang).find(chapter => chapter.id === 'sdk-installation')!.title)
      expect(html).not.toContain('<h2>第一步：安装 SDK 引擎</h2>')
      expect(html).toContain(locale === 'ar' ? 'dir="rtl"' : 'dir="ltr"')
    })
  }

  for (const lang of ['en-US', 'fr-FR', 'de-DE', 'ar'] as const) {
    it(`provides complete ${lang} chapters and preserves links and screenshots`, () => {
      const chapters = getManualChapters(lang)
      expect(chapters.map(chapter => chapter.id)).toEqual(manualChapters.map(chapter => chapter.id))
      for (const [index, chapter] of chapters.entries()) {
        const source = manualChapters[index]
        expect(chapter.title).not.toBe(source.title)
        expect(chapter.summary).not.toBe(source.summary)
        expect(chapter.sections).toHaveLength(source.sections.length)
        chapter.sections.forEach((section, i) => {
          expect(section.steps).toHaveLength(source.sections[i].steps.length)
          expect(section.tips?.length).toBe(source.sections[i].tips?.length)
          expect(section.screenshot?.id).toBe(source.sections[i].screenshot?.id)
          expect(section.title).not.toBe(source.sections[i].title)
          section.steps.forEach((text, j) => expect(text).not.toBe(source.sections[i].steps[j]))
          section.tips?.forEach((text, j) => expect(text).not.toBe(source.sections[i].tips![j]))
          if (section.screenshot) {
            expect(section.screenshot.alt).not.toBe(source.sections[i].screenshot!.alt)
            expect(section.screenshot.caption).not.toBe(source.sections[i].screenshot!.caption)
          }
          for (const text of [...section.steps, ...section.tips ?? []]) expect(text.trim()).not.toBe('')
        })
      }
      const query = chapters[0].title
      expect(getManualGroups(query, lang).flatMap(group => group.chapters).map(chapter => chapter.id)).toContain(chapters[0].id)
      expect(getManualGroups('', lang)[0].title).not.toBe('快速入门')
    })
  }
})
