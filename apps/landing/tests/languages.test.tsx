import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Nav } from '../src/components/Nav'
import { Hero } from '../src/components/Hero'
import { I18nProvider } from '../src/i18n'
import { ManualPage } from '../src/manual/ManualPage'

afterEach(() => vi.unstubAllGlobals())

describe('builtin language selection', () => {
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
      expect(html).toContain('lang="zh-CN"')
    })
  }
})
