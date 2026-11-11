import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, expect, it, vi } from 'vitest'
import { I18nProvider, languageDirection, supportedLanguages } from '../src/i18n'
import { acceptableUseCopy } from '../src/i18n/acceptableUse'
import { Footer } from '../src/components/Footer'
import { TermsPage } from '../src/components/TermsPage'
import App from '../src/App'

afterEach(() => vi.unstubAllGlobals())

it.each(supportedLanguages.map(({ locale }) => locale))('shows policy links and only the selected policy language in %s', lang => {
  vi.stubGlobal('window', { localStorage: { getItem: () => lang }, navigator: { language: lang }, location: { hash: '#acceptable-use', pathname: '/' } })
  const copy = acceptableUseCopy[lang]
  for (const component of [<Footer />, <TermsPage />]) {
    const html = renderToStaticMarkup(<I18nProvider>{component}</I18nProvider>)
    expect(html).toContain('href="#acceptable-use"')
    expect(html).toContain(copy.title)
    expect(html).not.toContain('EN / 简体中文')
  }
  const html = renderToStaticMarkup(<I18nProvider><App /></I18nProvider>)
  expect(html).toContain(`lang="${lang}" dir="${languageDirection(lang)}"`)
  expect(html).toContain(`<h1>${copy.title}</h1>`)
  expect(copy.prohibited).toHaveLength(6)
  expect(html).toContain('mailto:support@workstep.me')
  expect(html).toContain('Apache License 2.0')
  expect(html).not.toContain('id="english"')
  expect(html).not.toContain('id="chinese"')
  expect(html).not.toContain('class="landing-home"')
  if (lang !== 'zh-CN') expect(html).not.toContain(acceptableUseCopy['zh-CN'].intro)
  if (lang !== 'en-US') expect(html).not.toContain(acceptableUseCopy['en-US'].intro)
})

it('keeps old public policy URLs working without a separate bilingual document', () => {
  const html = readFileSync(new URL('../public/acceptable-use.html', import.meta.url), 'utf8')
  expect(html).toContain('url=./#acceptable-use')
  expect(html).toContain('href="./#acceptable-use"')
  expect(html).not.toMatch(/<script|<iframe|<form|EN \/ 简体中文/i)
})
