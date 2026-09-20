import './helpers/domEnv.ts'

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'

import MarkdownContent from '../src/components/MarkdownContent.tsx'
import {
  resetMermaidForTests,
  setMermaidLoader,
  setMermaidPngConverter,
} from '../src/components/MermaidBlock.tsx'
import { I18nProvider } from '../src/i18n/index.tsx'

const diagram = 'flowchart LR\n  A --> B'
const styles = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')

function renderMarkdown(content: string, streaming = false) {
  return renderToStaticMarkup(
    <I18nProvider>
      <MarkdownContent content={content} streaming={streaming} />
    </I18nProvider>,
  )
}

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds))

test('keeps ordinary code fences unchanged and Mermaid as source while streaming', () => {
  const ordinary = renderMarkdown('```ts\nconst value = 1\n```')
  assert.match(ordinary, /<pre><code class="language-ts">/)

  let loads = 0
  setMermaidLoader(async () => {
    loads += 1
    throw new Error('must not load while streaming')
  })
  const mermaid = renderMarkdown(`\`\`\`mermaid\n${diagram}\n\`\`\``, true)

  assert.match(mermaid, /<pre class="mermaid-block__source"><code class="language-mermaid">/)
  assert.match(mermaid, /flowchart LR/)
  assert.doesNotMatch(mermaid, /mermaid-block__diagram/)
  assert.equal(loads, 0)
  resetMermaidForTests()
})

test('waits for stable content, renders once, and reuses the SVG cache', async () => {
  const renders: string[] = []
  let loads = 0
  setMermaidLoader(async () => {
    loads += 1
    return {
      initialize: () => {},
      render: async (_id: string, code: string) => {
        renders.push(code)
        return { svg: `<svg data-code="${code}"></svg>` }
      },
    }
  })

  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <MarkdownContent content={`\`\`\`mermaid\nflowchart LR\n  A\n\`\`\``} streaming />
        </I18nProvider>,
      )
    })
    await act(async () => { await wait(320) })
    assert.equal(loads, 0)
    assert.equal(renders.length, 0)
    await act(async () => {
      root.render(<I18nProvider><MarkdownContent content={`\`\`\`mermaid\nflowchart LR\n  A\n\`\`\``} /></I18nProvider>)
    })
    await act(async () => { await wait(180) })
    await act(async () => {
      root.render(<I18nProvider><MarkdownContent content={`\`\`\`mermaid\n${diagram}\n\`\`\``} /></I18nProvider>)
    })
    await act(async () => { await wait(180) })
    assert.equal(renders.length, 0)

    await act(async () => { await wait(160) })
    assert.deepEqual(renders, [diagram])
    assert.match(container.innerHTML, /mermaid-block__diagram/)
    assert.match(container.innerHTML, /<svg data-code=/)

    await act(async () => root.unmount())
    const cachedRoot = createRoot(container)
    await act(async () => {
      cachedRoot.render(<I18nProvider><MarkdownContent content={`\`\`\`mermaid\n${diagram}\n\`\`\``} /></I18nProvider>)
    })
    await act(async () => { await wait(320) })
    assert.equal(loads, 1)
    assert.equal(renders.length, 1)
    await act(async () => cachedRoot.unmount())
  } finally {
    container.remove()
    resetMermaidForTests()
  }
})

test('retries one transient Mermaid module load failure', async () => {
  let loads = 0
  setMermaidLoader(async () => {
    loads += 1
    if (loads === 1) throw new Error('stale optimized dependency')
    return {
      initialize: () => {},
      render: async () => ({ svg: '<svg data-retried="true"></svg>' }),
    }
  })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(<I18nProvider><MarkdownContent content={`\`\`\`mermaid\n${diagram}\n\`\`\``} /></I18nProvider>)
    })
    await act(async () => { await wait(620) })
    assert.equal(loads, 2)
    assert.match(container.innerHTML, /data-retried="true"/)
    assert.doesNotMatch(container.textContent ?? '', /rendering failed|渲染失败/i)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    resetMermaidForTests()
  }
})

test('opens an enlarged preview and exposes zoom controls', async () => {
  setMermaidLoader(async () => ({
    initialize: () => {},
    render: async () => ({ svg: '<svg viewBox="0 0 400 200"><text>Preview me</text></svg>' }),
  }))
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(<I18nProvider><MarkdownContent content={`\`\`\`mermaid\n${diagram}\n\`\`\``} /></I18nProvider>)
    })
    await act(async () => { await wait(320) })

    const trigger = container.querySelector<HTMLButtonElement>('.mermaid-block__preview-trigger')
    assert.ok(trigger)
    await act(async () => trigger.click())
    const dialog = document.body.querySelector<HTMLElement>('.mermaid-preview')
    assert.ok(dialog)
    assert.match(dialog.textContent ?? '', /Preview me/)
    assert.equal(dialog.querySelector('[data-testid="mermaid-preview-zoom-level"]')?.textContent, '100%')

    const zoomIn = dialog.querySelector<HTMLButtonElement>('[data-testid="mermaid-preview-zoom-in"]')
    assert.ok(zoomIn)
    await act(async () => zoomIn.click())
    assert.equal(dialog.querySelector('[data-testid="mermaid-preview-zoom-level"]')?.textContent, '125%')

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    assert.equal(document.body.querySelector('.mermaid-preview'), null)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    resetMermaidForTests()
  }
})

test('preview panel fits the rendered diagram height instead of stretching to the viewport', () => {
  const overlayRule = styles.match(/\.mermaid-preview\s*\{([\s\S]*?)\}/)?.[1] ?? ''
  const viewportRule = styles.match(/\.mermaid-preview__viewport\s*\{([\s\S]*?)\}/)?.[1] ?? ''

  assert.match(overlayRule, /align-items:\s*flex-start/)
  assert.match(viewportRule, /max-height:\s*calc\(100dvh\s*-\s*82px\)/)
})

test('copies the rendered Mermaid SVG to the clipboard as PNG', async () => {
  const writes: unknown[][] = []
  const previousClipboardItem = globalThis.ClipboardItem
  const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
  class FakeClipboardItem {
    constructor(readonly data: Record<string, Blob | Promise<Blob>>) {}
  }
  Object.defineProperty(globalThis, 'ClipboardItem', {
    configurable: true,
    value: FakeClipboardItem,
  })
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { write: async (items: unknown[]) => { writes.push(items) } },
  })
  setMermaidPngConverter(async () => new Blob(['png'], { type: 'image/png' }))
  setMermaidLoader(async () => ({
    initialize: () => {},
    render: async () => ({ svg: '<svg viewBox="0 0 400 200"></svg>' }),
  }))

  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(<I18nProvider><MarkdownContent content={`\`\`\`mermaid\n${diagram}\n\`\`\``} /></I18nProvider>)
    })
    await act(async () => { await wait(320) })
    const copy = container.querySelector<HTMLButtonElement>('.mermaid-block__copy')
    assert.ok(copy)
    await act(async () => {
      copy.click()
      await wait(0)
    })
    assert.equal(writes.length, 1)
    const item = writes[0][0] as FakeClipboardItem
    assert.ok(item.data['image/png'] instanceof Promise)
    assert.equal(copy.dataset.copyState, 'copied')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    resetMermaidForTests()
    if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
    else Reflect.deleteProperty(navigator, 'clipboard')
    if (previousClipboardItem) globalThis.ClipboardItem = previousClipboardItem
    else Reflect.deleteProperty(globalThis, 'ClipboardItem')
  }
})

test('falls back to source and shows a localized error when rendering fails', async () => {
  setMermaidLoader(async () => ({
    initialize: () => {},
    render: async () => { throw new Error('invalid diagram') },
  }))
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => {
      root.render(<I18nProvider><MarkdownContent content={`\`\`\`mermaid\n${diagram}\n\`\`\``} /></I18nProvider>)
    })
    await act(async () => { await wait(320) })
    assert.match(container.innerHTML, /mermaid-block__source/)
    assert.match(container.textContent ?? '', /Diagram rendering failed|流程图渲染失败/)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    resetMermaidForTests()
  }
})
