import { describe, expect, it } from 'vitest'
import { inlineDocument } from '../scripts/inline-dist.mjs'

describe('offline landing build', () => {
  it('resolves media next to the original bundle after inlining', () => {
    const html = inlineDocument({
      html: '<html><head><link rel="icon" href="./favicon.svg"><script type="module" crossorigin src="./assets/index-abc.js"></script><link rel="stylesheet" crossorigin href="./assets/index.css"></head><body><div id="root"></div></body></html>',
      javascript: 'const clip=new URL("walkthrough-abc.webm",import.meta.url).href;',
      stylesheet: 'body{color:black}', favicon: '<svg/>', brandMark: '<svg/>',
    })
    expect(html).not.toContain('import.meta.url')
    expect(html).toContain('document.baseURI')
    expect(html).toContain('assets/index-abc.js')
    expect(html).toContain('walkthrough-abc.webm')
  })
})
