import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import ImagePreview from '../src/components/ImagePreview'
import MermaidPreviewDialog from '../src/components/MermaidPreviewDialog'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { MarkdownAssetUrlProvider } from '../src/contexts/MarkdownAssetUrlContext'
import { installDomEnvironment } from './helpers/domEnv'

test('preview copies resolved addresses and image contents and reports failures', async () => {
  const { window, document } = installDomEnvironment()
  useLocaleStore.getState().setLocale('zh-CN')
  let copied = ''
  let imageSource = ''
  let deny = false
  let written: Blob | undefined
  const png = new Blob(['png'], { type: 'image/png' })
  const originalImage = globalThis.Image
  const originalItem = globalThis.ClipboardItem
  const createElement = document.createElement.bind(document)
  Object.assign(globalThis, {
    Image: class {
      naturalWidth = 20
      naturalHeight = 10
      onload?: () => void
      set src(value: string) { imageSource = value; queueMicrotask(() => this.onload?.()) }
    },
    ClipboardItem: class {
      constructor(public data: Record<string, Promise<Blob>>) {}
    },
  })
  document.createElement = ((tag: string, options?: ElementCreationOptions) => {
    const element = createElement(tag, options)
    if (tag === 'canvas') Object.assign(element, {
      getContext: () => ({ drawImage: () => {} }),
      toBlob: (callback: BlobCallback) => callback(png),
    })
    return element
  }) as typeof document.createElement
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    writeText: async (value: string) => { copied = value; if (deny) throw Error('denied') },
    write: async (items: { data: Record<string, Promise<Blob>> }[]) => {
      written = await items[0].data['image/png']
      if (deny) throw Error('denied')
    },
  } })
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  let closed = false
  try {
    await act(async () => root.render(<I18nProvider>
      <MarkdownAssetUrlProvider resolver={() => '/workspace/demo/image.jpg?share=test'}>
        <ImagePreview src="relative.jpg" onClose={() => { closed = true }} />
      </MarkdownAssetUrlProvider>
    </I18nProvider>))
    const previewImage = document.querySelector('.image-preview-window img')!
    assert.equal((previewImage.closest('.image-preview-viewport, .desktop-image-preview') ?? previewImage).nextElementSibling?.className, 'image-preview-toolbar')
    const button = (label: string) => {
      const found = [...document.querySelectorAll('button')].find(item => item.getAttribute('aria-label') === label)
      assert.ok(found, label)
      return found
    }
    await act(async () => button('复制地址').click())
    assert.equal(copied, 'http://localhost/workspace/demo/image.jpg?share=test')
    assert.match(document.querySelector('.image-preview-toolbar')!.textContent!, /已复制/)
    await act(async () => button('复制图片').click())
    assert.equal(imageSource, '/workspace/demo/image.jpg?share=test')
    assert.equal(written, png)
    assert.equal(closed, false)
    assert.equal(document.querySelector('.image-preview-toolbar > [role="status"]') === null, true)
    assert.match(button('复制图片').textContent!, /已复制/)
    deny = true
    for (const label of ['复制图片', '复制地址']) {
      await act(async () => button(label).click())
      assert.match(document.querySelector('.image-preview-toolbar')!.textContent!, /复制失败/)
    }
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined })
    await act(async () => button('复制图片').click())
    assert.match(document.querySelector('.image-preview-toolbar')!.textContent!, /复制失败/)
  } finally {
    await act(async () => root.unmount())
    Object.assign(globalThis, { Image: originalImage, ClipboardItem: originalItem })
    await window.happyDOM.close()
  }
})

test('download saves original bytes using the resolved image URL and reports HTTP errors', async () => {
  const { window, document } = installDomEnvironment()
  useLocaleStore.getState().setLocale('zh-CN')
  const originalFetch = globalThis.fetch
  const originalCreate = URL.createObjectURL
  const originalRevoke = URL.revokeObjectURL
  let requested = ''
  let saved: Blob | undefined
  let filename = ''
  let clicked = 0
  let fail = false
  const original = new Blob(['original jpeg bytes'], { type: 'image/jpeg' })
  globalThis.fetch = (async (url: string) => {
    requested = url
    return { ok: !fail, blob: async () => original }
  }) as typeof fetch
  URL.createObjectURL = blob => { saved = blob as Blob; return 'blob:http://localhost/image' }
  URL.revokeObjectURL = () => {}
  const createElement = document.createElement.bind(document)
  document.createElement = ((tag: string) => {
    const element = createElement(tag)
    if (tag === 'a') element.click = () => {
      filename = (element as HTMLAnchorElement).download
      clicked++
    }
    return element
  }) as typeof document.createElement
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<I18nProvider>
      <MarkdownAssetUrlProvider resolver={() => '/workspace/demo/api/fs/file?path=images%2F原图.jpg&share=test'}>
        <ImagePreview src="images/原图.jpg" onClose={() => {}} />
      </MarkdownAssetUrlProvider>
    </I18nProvider>))
    const button = [...document.querySelectorAll('button')].find(item => item.textContent === '下载图片')
    assert.ok(button)
    assert.equal(button.parentElement?.className, 'image-preview-toolbar')
    await act(async () => button.click())
    assert.equal(requested, '/workspace/demo/api/fs/file?path=images%2F原图.jpg&share=test')
    assert.equal(saved, original)
    assert.equal(filename, '原图.jpg')
    assert.equal(clicked, 1)
    assert.equal(document.querySelector('.image-preview-toolbar > [role="status"]') === null, true)
    fail = true
    await act(async () => button.click())
    assert.equal(clicked, 1)
    assert.match(document.querySelector('.image-preview-toolbar')!.textContent!, /下载失败/)
    assert.equal(button.disabled, false)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
    globalThis.fetch = originalFetch
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
  }
})

test('preview keeps close inside the window and only shows a desktop drag handle', async () => {
  for (const width of [320, 390, 1023, 1280]) {
    const { window, document } = installDomEnvironment()
    window.happyDOM.setWindowSize({ width, height: 900 })
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    let closed = false
    try {
      await act(async () => root.render(<I18nProvider>
        <ImagePreview src="/image.png" onClose={() => { closed = true }} />
      </I18nProvider>))
      assert.equal(document.querySelector('.image-preview')?.parentElement, document.body)
      const panel = document.querySelector('.image-preview-window')!
      assert.equal(Boolean(panel.querySelector('[data-dialog-drag-handle]')), width > 1023)
      const close = panel.querySelector<HTMLButtonElement>('.image-preview-close')
      assert.ok(close, 'close button belongs to the preview window')
      assert.equal(close.parentElement?.className, width <= 1023 ? 'image-preview-window resizable-panel' : 'image-preview-header')
      assert.equal(Boolean(panel.querySelector('.image-preview-header')), width > 1023)
      await act(async () => close.click())
      assert.equal(closed, true)
    } finally {
      await act(async () => root.unmount())
      await window.happyDOM.close()
    }
  }
})

test('Android and iOS hand service image downloads directly to the native browser', async () => {
  for (const bridge of ['WorkStepAndroid', 'WorkStepIOS']) {
    const { window, document } = installDomEnvironment()
    window.happyDOM.setWindowSize({ width: 390, height: 844 })
    Object.assign(window, { [bridge]: { postMessage() {} } })
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => { throw Error('native downloads must not fetch a blob') }
    const createElement = document.createElement.bind(document)
    let href = ''
    let filename = ''
    document.createElement = ((tag: string) => {
      const element = createElement(tag)
      if (tag === 'a') element.click = () => {
        href = (element as HTMLAnchorElement).href
        filename = (element as HTMLAnchorElement).download
      }
      return element
    }) as typeof document.createElement
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    try {
      await act(async () => root.render(<I18nProvider>
        <MarkdownAssetUrlProvider resolver={() => '/workspace/demo/api/fs/file?path=images%2F原图.jpg&share=test'}>
          <ImagePreview src="images/原图.jpg" onClose={() => {}} />
        </MarkdownAssetUrlProvider>
      </I18nProvider>))
      assert.equal(document.querySelector('.image-preview-close')!.hasAttribute('title'), false)
      const button = [...document.querySelectorAll('button')].find(item => item.textContent === '下载图片')!
      await act(async () => button.click())
      assert.equal(new URL(href).pathname, '/workspace/demo/api/fs/file')
      assert.equal(new URL(href).searchParams.get('path'), 'images/原图.jpg')
      assert.equal(new URL(href).searchParams.get('share'), 'test')
      assert.equal(filename, '原图.jpg')
      assert.equal(document.querySelector('.image-preview-toolbar > [role="status"]') === null, true)
    } finally {
      await act(async () => root.unmount())
      globalThis.fetch = originalFetch
      await window.happyDOM.close()
    }
  }
})


test('diagram preview downloads a standalone SVG and skips project asset resolution', async () => {
  const { window, document } = installDomEnvironment()
  useLocaleStore.getState().setLocale('zh-CN')
  const originalCreate = URL.createObjectURL
  const originalRevoke = URL.revokeObjectURL
  let saved: Blob | undefined
  let filename = ''
  URL.createObjectURL = blob => { saved = blob as Blob; return 'blob:http://localhost/diagram' }
  URL.revokeObjectURL = () => {}
  const createElement = document.createElement.bind(document)
  document.createElement = ((tag: string) => {
    const element = createElement(tag)
    if (tag === 'a') element.click = () => { filename = (element as HTMLAnchorElement).download }
    return element
  }) as typeof document.createElement
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<I18nProvider>
      <MarkdownAssetUrlProvider resolver={() => { throw Error('generated SVG is not a project asset') }}>
        <MermaidPreviewDialog svg='<svg viewBox="0 0 400 200"><text>流程图</text></svg>' onClose={() => {}} />
      </MarkdownAssetUrlProvider>
    </I18nProvider>))
    const button = [...document.querySelectorAll('button')].find(item => item.textContent === '下载图片')!
    await act(async () => button.click())
    assert.equal(filename, 'image.svg')
    assert.equal(saved?.type.split(';')[0], 'image/svg+xml')
    const source = await saved!.text()
    assert.match(source, /xmlns="http:\/\/www.w3.org\/2000\/svg"/)
    assert.match(source, /viewBox="0 0 400 200"/)
    assert.match(source, /流程图/)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
    URL.createObjectURL = originalCreate
    URL.revokeObjectURL = originalRevoke
  }
})


test('diagram double click zoom anchors the pointer and leaves wheel scrolling available', async () => {
  const { window, document } = installDomEnvironment()
  window.innerWidth = 1400
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<I18nProvider>
      <MermaidPreviewDialog svg='<svg viewBox="0 0 400 200"></svg>' onClose={() => {}} />
    </I18nProvider>))
    const viewport = document.querySelector<HTMLElement>('.mermaid-preview__scroll')!
    viewport.scrollLeft = 0
    viewport.scrollTop = 0
    const canvas = viewport.firstElementChild as HTMLElement
    canvas.getBoundingClientRect = () => {
      const scale = Number.parseFloat(canvas.style.width) / 100
      return { left: 0, top: 0, width: 400 * scale, height: 200 * scale } as DOMRect
    }
    const level = () => document.querySelector('[data-testid="mermaid-preview-zoom-level"]')!.textContent
    const wheel = new window.WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true })
    await act(async () => { viewport.dispatchEvent(wheel) })
    assert.equal(wheel.defaultPrevented, false)
    assert.equal(level(), '100%')
    const doubleClick = async () => {
      await act(async () => { canvas.dispatchEvent(new window.MouseEvent('dblclick', { clientX: 200, clientY: 100, bubbles: true, cancelable: true })) })
    }
    await doubleClick()
    assert.equal(level(), '200%')
    assert.equal(viewport.scrollLeft, 200)
    assert.equal(viewport.scrollTop, 100)
    await act(async () => { viewport.dispatchEvent(wheel) })
    assert.equal(wheel.defaultPrevented, false)
    assert.equal(level(), '200%')
    await doubleClick()
    assert.equal(level(), '100%')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})


test('desktop image preview zooms on double click and retains wheel scrolling', async () => {
  const { window, document } = installDomEnvironment()
  window.innerWidth = 1400
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<I18nProvider><ImagePreview src="/large.png" onClose={() => {}} /></I18nProvider>))
    const viewport = document.querySelector<HTMLElement>('.desktop-image-preview')!
    assert.ok(viewport)
    const image = viewport.querySelector('img')!
    image.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 200 }) as DOMRect
    await act(async () => { image.dispatchEvent(new window.Event('load')) })
    await act(async () => { image.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, clientX: 100, clientY: 50 })) })
    assert.equal(image.style.width, '800px')
    const wheel = new window.WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true })
    await act(async () => { viewport.dispatchEvent(wheel) })
    assert.equal(wheel.defaultPrevented, false)
    await act(async () => { image.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, clientX: 100, clientY: 50 })) })
    assert.equal(image.style.width, '400px')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
