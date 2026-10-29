import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Demos } from '../src/components/Demos'
import { I18nProvider } from '../src/i18n'

afterEach(() => vi.unstubAllGlobals())

describe('mechanism gallery playback', () => {
  function render(reducedMotion = false) {
    vi.stubGlobal('window', {
      matchMedia: () => ({ matches: reducedMotion }),
      localStorage: { getItem: () => 'zh-CN' },
      navigator: { language: 'zh-CN' },
    })
    return renderToStaticMarkup(<I18nProvider><Demos onOpen={() => {}} /></I18nProvider>)
  }

  it('starts the selected demo playing and loops until paused', () => {
    const html = render()
    expect(html).toContain('aria-label="暂停"')
    expect(html).toContain('class="player-chip"')
    expect(html).toContain('type="range"')
  })

  it('starts paused when reduced motion is requested', () => {
    expect(render(true)).toContain('aria-label="播放"')
  })
})
