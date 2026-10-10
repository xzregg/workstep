import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { I18nProvider } from '../src/i18n'
import { CanvasScene } from '../src/scenes/CanvasScene'

describe('canvas rework feedback', () => {
  it('anchors the feedback path to the test and frontend node positions', () => {
    const html = renderToStaticMarkup(<I18nProvider><CanvasScene time={6500} /></I18nProvider>)
    const path = html.match(/d="([^"]+)" class="canvas-loop-edge"/)![1]
    const coordinates = path.match(/-?\d+(?:\.\d+)?/g)!.map(Number)

    expect(coordinates.slice(0, 2)).toEqual([720, 224.8])
    expect(coordinates.slice(-2)).toEqual([510, 78.68])
    expect(html).toContain(`path="${path}"`)
  })
})
