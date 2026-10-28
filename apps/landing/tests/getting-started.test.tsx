import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GettingStarted, getGettingStartedSteps } from '../src/components/GettingStarted'
import { I18nProvider, supportedLanguages } from '../src/i18n'
import { getManualChapters } from '../src/manual/content'

afterEach(() => vi.unstubAllGlobals())
describe('homepage onboarding', () => {
  for (const { locale } of supportedLanguages) {
    it(`shows actual translated SDK setup and screenshots in ${locale}`, () => {
      vi.stubGlobal('window', { localStorage: { getItem: () => locale }, navigator: { language: locale } })
      const steps = getGettingStartedSteps(locale)
      expect(steps.map(step => step.id)).toEqual(['sdk-installation', 'sdk-credentials', 'execution-defaults', 'local-projects', 'first-workflow', 'first-task'])
      const chapter = getManualChapters(locale).find(item => item.id === 'sdk-installation')!
      const html = renderToStaticMarkup(<I18nProvider><GettingStarted /></I18nProvider>)
      expect(html).toContain(chapter.title)
      expect(html).toContain('sdk-install-version')
      expect(html).toContain('href="#docs/sdk-installation"')
      expect(steps.every(step => step.sections.length > 0)).toBe(true)
      expect(html).toContain('aria-selected="true"')
    })
  }
})
