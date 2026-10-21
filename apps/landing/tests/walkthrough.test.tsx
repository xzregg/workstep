import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GuidedWalkthrough } from '../src/components/GuidedWalkthrough'
import { getWalkthroughFrame, getWalkthroughCamera } from '../src/demo/walkthrough'
import { I18nProvider } from '../src/i18n'

describe('recorded walkthrough', () => {
  it('progressively reveals and restores cumulative steps when seeking', () => {
    expect(getWalkthroughFrame(.1)).toMatchObject({ chapter: 0, revealed: 0 })
    expect(getWalkthroughFrame(.9)).toMatchObject({ chapter: 0, revealed: 1 })
    expect(getWalkthroughFrame(3.4)).toMatchObject({ chapter: 0, revealed: 2 })
    expect(getWalkthroughFrame(7.5)).toMatchObject({ chapter: 0, revealed: 4 })
    expect(getWalkthroughFrame(9.244)).toMatchObject({ chapter: 1, revealed: 0 })
    expect(getWalkthroughFrame(19.8)).toMatchObject({ chapter: 2, revealed: 3 })
    expect(getWalkthroughFrame(31)).toMatchObject({ chapter: 3, revealed: 4 })
    expect(getWalkthroughFrame(3.4)).toMatchObject({ chapter: 0, revealed: 2 })
  })

  it('keeps the current operation visible to the right of the commentary', () => {
    const form = getWalkthroughCamera(19.8, 1280, 720, false, false)
    expect(form.zoom).toBeCloseTo(1.7)
    const result = getWalkthroughCamera(29.8, 1280, 720, false, false)
    expect(result.x).toBeGreaterThan(0)
    expect(result.x).toBeLessThanOrEqual(1280 * .3)
    expect(getWalkthroughCamera(19.8, 1280, 720, false, true)).toEqual({ zoom: 1, x: 0, y: 0 })
  })

  it('renders actual video, accessible playback and chapter controls', () => {
    const html = renderToStaticMarkup(<I18nProvider><GuidedWalkthrough /></I18nProvider>)
    expect(html).toContain('id="demos"')
    expect(html).toContain('<video')
    expect(html).toContain('workstep-tutorial.webm')
    expect(html).toContain('先看流程，')
    expect(html).toContain('aria-label="演示进度"')
    expect(html).toContain('aria-label="播放演示"')
    expect(html).toContain('任务保持预备中')
    expect(html).not.toContain('autoPlay')
  })
})
