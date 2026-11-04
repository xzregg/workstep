import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ProductIntroVideo } from '../src/components/ProductIntro'
import { getProductIntroMedia } from '../src/config/productIntro'
import { supportedLanguages } from '../src/i18n'
import { productIntroCopy } from '../src/i18n/productIntro'

describe('localized product introduction', () => {
  it.each(supportedLanguages.map(({locale}) => locale))('selects the matching narration and captions for %s', locale => {
    const media = getProductIntroMedia(locale)
    const chinese = locale === 'zh-CN' || locale === 'zh-TW'
    expect(media.language).toBe(chinese ? 'zh' : 'en')
    expect(media.src).toContain(chinese ? 'workstep-intro-zh' : 'workstep-intro-en')
    expect(media.poster).toContain(chinese ? 'workstep-intro-zh' : 'workstep-intro-en')
    expect(media.captions).toContain(chinese ? 'workstep-intro-zh' : 'workstep-intro-en')
    expect(productIntroCopy[locale].title).toBeTruthy()
    expect(productIntroCopy[locale].description).toBeTruthy()
  })

  it.each(['zh-CN', 'zh-TW', 'en-US', 'ja-JP'] as const)('renders only a poster and play button before user interaction for %s', locale => {
    const html = renderToStaticMarkup(<ProductIntroVideo locale={locale} errorLabel="Load failed" retryLabel="Retry" />)
    const media = getProductIntroMedia(locale)
    expect(html).not.toContain(media.src)
    expect(html).toContain(media.poster)
    expect(html).toContain('<button')
    expect(html).not.toContain('controls=""')
    expect(html).toContain('preload="none"')
    expect(html).toContain('playsInline=""')
    expect(html).not.toContain('<source')
    expect(html).not.toContain('<track')
    expect(html).not.toContain('autoPlay')
    expect(html).not.toContain('muted')
  })
})
