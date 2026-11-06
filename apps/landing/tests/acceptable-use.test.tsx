import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { I18nProvider } from '../src/i18n'
import { Footer } from '../src/components/Footer'
import { TermsPage } from '../src/components/TermsPage'

it('makes the bilingual AI acceptable-use policy discoverable from the homepage and terms', () => {
  for (const component of [<Footer />, <TermsPage />]) {
    const html = renderToStaticMarkup(<I18nProvider>{component}</I18nProvider>)
    expect(html).toContain('href="./acceptable-use.html"')
    expect(html).toContain('EN / 简体中文')
  }
})

it('publishes a readable policy without scripts, personal contacts or tracking', () => {
  const html = readFileSync(new URL('../public/acceptable-use.html', import.meta.url), 'utf8')
  expect(html).toContain('AI-generated code and text')
  expect(html).toContain('sexually explicit or NSFW content')
  expect(html).toContain('禁止使用 WorkStep 的 AI 工作流生成色情、露骨性内容或 NSFW 内容')
  expect(html).toContain('unauthorized access')
  expect(html).toContain('personal data')
  expect(html).toContain('mailto:support@workstep.me')
  expect([...html.matchAll(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/g)].map(match => match[0])).toEqual(['support@workstep.me'])
  expect(html).not.toMatch(/<script|<iframe|<form|gmail\.com|\b\d{17}[\dXx]\b/i)
})
