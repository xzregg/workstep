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
      expect(html).toContain('href="#download"')
      expect(html).toContain('href="#engines"')
      expect(html).not.toContain('href="#docs/getting-started"')
      expect(html).not.toContain('href="#docs/faq"')
      expect(steps.every(step => step.sections.length > 0)).toBe(true)
      for (const step of steps) {
        expect(html).toContain(`class="start-step-link" aria-controls="start-panel" aria-pressed="${step.id === chapter.id}"`)
      }
      expect(html.match(/<button type="button" class="start-step-link"/g)).toHaveLength(steps.length)
      expect(html).toContain('class="start-manual" href="#docs"')
      expect(html).not.toContain('role="tab"')
    })
  }
})
