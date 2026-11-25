import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import App from '../src/App'
import { I18nProvider, supportedLanguages } from '../src/i18n'
import { homepageFaqCopy } from '../src/i18n/homepageFaq'

describe('homepage frequently asked questions', () => {
  it('adds four collapsed questions after onboarding', () => {
    const html = renderToStaticMarkup(<I18nProvider><App /></I18nProvider>)
    const faq = html.match(/<section[^>]*id="faq"[\s\S]*?<\/section>/)?.[0]
    expect(faq).toContain('开始之前，你可能想知道。')
    expect(faq?.match(/<summary/g)).toHaveLength(4)
    expect(faq).not.toMatch(/<details[^>]*\bopen/)
    expect(faq).toContain('我不会画流程，也可以开始吗？')
    expect(faq).toContain('什么时候值得用流程？')
    expect(faq).toContain('它怎样判断工作完成了？')
    expect(faq).toContain('我的材料保存在哪里？')
    expect(html.indexOf('id="faq"')).toBeGreaterThan(html.indexOf('id="start"'))
  })

  it.each(supportedLanguages.map(({ locale }) => locale))('provides complete FAQ copy in %s', locale => {
    const copy = homepageFaqCopy[locale]
    expect(copy.title.trim()).not.toBe('')
    expect(copy.items).toHaveLength(4)
    for (const [question, answer] of copy.items) {
      expect(question.trim()).not.toBe('')
      expect(answer.trim()).not.toBe('')
      if (!locale.startsWith('zh')) expect(question).not.toBe(homepageFaqCopy['zh-CN'].items[0][0])
    }
  })
})
