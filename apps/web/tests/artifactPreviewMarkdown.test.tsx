import './helpers/domEnv.ts'

import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'

import ArtifactPreview from '../src/components/ArtifactPreview.tsx'
import {
  resetMermaidForTests,
  setMermaidLoader,
} from '../src/components/MermaidBlock.tsx'
import FilePreviewPage from '../src/pages/FilePreviewPage.tsx'
import { I18nProvider } from '../src/i18n/index.tsx'
import { installDomEnvironment } from './helpers/domEnv.ts'

function markdownPreviewResponse() {
  return new Response(JSON.stringify({
    type: 'text',
    content_type: 'text/markdown',
    content: '# Guide\n\nRendered **markdown** content.',
    file_size: 38,
    extension: '.md',
    relative_path: 'docs/guide.md',
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function mermaidPreviewResponse() {
  return new Response(JSON.stringify({
    type: 'text',
    content_type: 'text/markdown',
    content: '# Flow\n\n```mermaid\nflowchart TD\n  A --> B\n```',
    file_size: 52,
    extension: '.md',
    relative_path: 'docs/flow.md',
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function findByText(document: Document, selector: string, pattern: RegExp) {
  return Array.from(document.querySelectorAll(selector)).find((element) =>
    pattern.test(element.textContent ?? ''),
  )
}

function findButtonByText(document: Document, pattern: RegExp) {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    .find((button) => pattern.test(button.textContent ?? ''))
}

test('markdown preview renders markdown by default and can switch to source', async () => {
  const { window, document } = installDomEnvironment()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => markdownPreviewResponse()
  const root = createRoot(document.body.appendChild(document.createElement('div')))

  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <ArtifactPreview path="docs/guide.md" projectId="project:one" />
        </I18nProvider>,
      )
    })
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })
    assert.equal(document.querySelector('.markdown-message h1')?.textContent, 'Guide')
    assert.match(document.querySelector('.markdown-message')?.textContent ?? '', /Rendered markdown content\./)

    const sourceButton = findButtonByText(document, /查看原文|View source/)
    assert.ok(sourceButton)
    await act(async () => {
      sourceButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })

    assert.equal(document.querySelector('.markdown-message'), null)
    assert.match(document.querySelector('.code-preview')?.textContent ?? '', /# Guide/)
    assert.ok(findButtonByText(document, /查看渲染|View rendered/))
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    await window.happyDOM.close()
  }
})

test('markdown file preview renders Mermaid diagrams like chat messages', async () => {
  const { window, document } = installDomEnvironment()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => mermaidPreviewResponse()
  setMermaidLoader(async () => ({
    initialize: () => {},
    render: async (_id: string, code: string) => ({
      svg: `<svg data-diagram="${code.split('\n')[0]}"></svg>`,
    }),
  }))
  const root = createRoot(document.body.appendChild(document.createElement('div')))

  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <ArtifactPreview path="docs/flow.md" projectId="project:one" />
        </I18nProvider>,
      )
    })
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })

    assert.ok(document.querySelector('.artifact-markdown-preview .mermaid-block__diagram'))
    assert.equal(
      document.querySelector('.artifact-markdown-preview svg')?.getAttribute('data-diagram'),
      'flowchart TD',
    )
    assert.equal(document.querySelector('.artifact-markdown-preview .mermaid-block__source'), null)
  } finally {
    await act(async () => root.unmount())
    resetMermaidForTests()
    globalThis.fetch = originalFetch
    await window.happyDOM.close()
  }
})

test('file preview opens the standalone preview route with toolbar state', async () => {
  const { window, document } = installDomEnvironment()
  const originalFetch = globalThis.fetch
  const originalOpen = window.open
  let openedUrl = ''
  globalThis.fetch = async () => markdownPreviewResponse()
  window.open = ((url: string | URL) => {
    openedUrl = String(url)
    return null
  }) as typeof window.open
  const root = createRoot(document.body.appendChild(document.createElement('div')))

  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <ArtifactPreview path="docs/guide.md" line={3} projectId="project:one" />
        </I18nProvider>,
      )
    })
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })

    const openButton = findButtonByText(document, /在新窗口打开|Open in new window/)
    assert.ok(openButton)
    await act(async () => {
      openButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })

    assert.equal(
      openedUrl,
      '/file-preview?path=docs%2Fguide.md&name=guide.md&project_id=project%3Aone&line=3',
    )
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    window.open = originalOpen
    await window.happyDOM.close()
  }
})

test('standalone preview page keeps the file toolbar buttons', async () => {
  const { window, document } = installDomEnvironment()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => markdownPreviewResponse()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const url = '/file-preview?path=docs%2Fguide.md&name=guide.md&project_id=project%3Aone'

  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <MemoryRouter initialEntries={[url]}>
            <FilePreviewPage />
          </MemoryRouter>
        </I18nProvider>,
      )
    })
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })

    assert.equal(document.querySelector('.markdown-message h1')?.textContent, 'Guide')
    assert.ok(document.querySelector('a[download]'))
    assert.ok(document.querySelector('button[aria-label*="Copy"], button[aria-label*="复制"]'))
    assert.ok(findByText(document, 'button', /在新窗口打开|Open in new window/))
    assert.ok(findByText(document, 'button', /关闭|Close/))
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    await window.happyDOM.close()
  }
})

test('directory artifacts open the directory browser instead of file preview', async () => {
  const { window, document } = installDomEnvironment()
  const originalFetch = globalThis.fetch
  let requestedUrl = ''
  globalThis.fetch = async (input) => {
    requestedUrl = String(input)
    return new Response(JSON.stringify({
      path: '/artifacts/方案目录',
      name: '方案目录',
      parent: '/artifacts',
      entries: [
        { name: 'solution.md', type: 'file', path: '/artifacts/方案目录/solution.md' },
      ],
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  const root = createRoot(document.body.appendChild(document.createElement('div')))

  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <ArtifactPreview path="/artifacts/方案目录" isDir projectId="project:one" />
        </I18nProvider>,
      )
    })
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    })

    assert.match(requestedUrl, /\/fs\/browse\?path=/)
    assert.doesNotMatch(requestedUrl, /\/fs\/preview\?path=/)
    assert.match(document.body.textContent ?? '', /solution\.md/)
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    await window.happyDOM.close()
  }
})
