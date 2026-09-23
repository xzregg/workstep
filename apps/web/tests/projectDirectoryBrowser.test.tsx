import './helpers/domEnv.ts'

import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'

import ProjectDirectoryBrowser from '../src/components/ProjectDirectoryBrowser.tsx'
import { I18nProvider } from '../src/i18n/index.tsx'
import { installDomEnvironment } from './helpers/domEnv.ts'

const json = (body: unknown) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
})

test('loads the project root, lazily expands folders, and previews selected files', async () => {
  const { window, document } = installDomEnvironment()
  const originalFetch = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = async (input) => {
    const url = String(input)
    requests.push(url)
    if (url.includes('/fs/preview')) {
      return json({
        type: 'text', content_type: 'text/markdown', content: '# Guide',
        file_size: 7, extension: '.md', relative_path: 'docs/guide.md',
      })
    }
    if (url.includes('path=docs')) {
      return json({
        path: '/srv/demo/docs', relative_path: 'docs', name: 'docs',
        parent: '/srv/demo', parent_relative_path: '',
        entries: [{
          name: 'guide.md', type: 'file', path: '/srv/demo/docs/guide.md',
          relative_path: 'docs/guide.md',
        }],
      })
    }
    const entries = [
      { name: 'docs', type: 'directory', path: '/srv/demo/docs', relative_path: 'docs' },
      ...(url.includes('include_hidden=true') ? [
        { name: '.workstep', type: 'directory', path: '/srv/demo/.workstep', relative_path: '.workstep' },
        { name: '.env', type: 'file', path: '/srv/demo/.env', relative_path: '.env' },
      ] : []),
    ]
    return json({
      path: '/srv/demo', relative_path: '', name: 'demo', parent: null,
      parent_relative_path: null,
      entries,
    })
  }
  const root = createRoot(document.body.appendChild(document.createElement('div')))

  try {
    await act(async () => {
      root.render(
        <I18nProvider>
          <ProjectDirectoryBrowser projectId="remote:one" />
        </I18nProvider>,
      )
    })
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)) })

    assert.match(requests[0], /\/fs\/browse\?project_id=remote%3Aone$/)
    const hiddenSwitch = document.querySelector<HTMLButtonElement>('[role="switch"]')
    assert.ok(hiddenSwitch)
    assert.ok(hiddenSwitch.closest('.project-directory-tree-actions'))
    assert.equal(hiddenSwitch.nextElementSibling?.getAttribute('aria-label'), 'Expand two folder levels')
    assert.equal(document.querySelector('.project-directory-hidden-control'), null)
    assert.equal(document.querySelector('.project-directory-preview-toolbar'), null)
    assert.equal(hiddenSwitch.getAttribute('aria-checked'), 'false')
    let visibleNames = Array.from(document.querySelectorAll<HTMLElement>('.project-directory-tree-name'))
      .map((entry) => entry.textContent)
    assert.ok(!visibleNames.includes('.env'))
    assert.ok(!visibleNames.includes('.workstep'))

    await act(async () => hiddenSwitch.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)) })
    assert.equal(hiddenSwitch.getAttribute('aria-checked'), 'true')
    assert.match(requests[1], /\/fs\/browse\?project_id=remote%3Aone&include_hidden=true/)
    visibleNames = Array.from(document.querySelectorAll<HTMLElement>('.project-directory-tree-name'))
      .map((entry) => entry.textContent)
    assert.ok(visibleNames.includes('.env'))
    assert.ok(visibleNames.includes('.workstep'))
    const docs = Array.from(document.querySelectorAll<HTMLElement>('[role="treeitem"]'))
      .find((entry) => /docs/.test(entry.textContent ?? ''))
    assert.ok(docs)
    assert.equal(docs.getAttribute('aria-expanded'), 'false')

    await act(async () => docs.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)) })
    assert.match(requests[2], /path=docs/)
    assert.match(requests[2], /include_hidden=true/)

    const file = Array.from(document.querySelectorAll<HTMLElement>('[role="treeitem"]'))
      .find((entry) => /guide\.md/.test(entry.textContent ?? ''))
    assert.ok(file)
    await act(async () => file.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)) })

    assert.ok(requests.some((url) => /\/fs\/preview\?path=docs%2Fguide\.md/.test(url)))
    assert.equal(document.querySelector('.markdown-message h1')?.textContent, 'Guide')

    await act(async () => hiddenSwitch.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)) })
    assert.equal(hiddenSwitch.getAttribute('aria-checked'), 'false')
    assert.ok(!Array.from(document.querySelectorAll<HTMLElement>('.project-directory-tree-name'))
      .some((entry) => entry.textContent === '.env'))
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    await window.happyDOM.close()
  }
})

test('expands two folder levels, collapses them, and searches every file under the root', async () => {
  const { window, document } = installDomEnvironment()
  const originalFetch = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = async (input) => {
    const url = String(input)
    requests.push(url)
    if (url.includes('/fs/search')) {
      return json({
        query: 'readme', truncated: false,
        entries: [
          {
            name: 'README.md', type: 'file', path: '/srv/demo/docs/api/README.md',
            relative_path: 'docs/api/README.md',
          },
          ...(url.includes('include_hidden=true') ? [{
            name: '.readme', type: 'file', path: '/srv/demo/.readme', relative_path: '.readme',
          }] : []),
        ],
      })
    }
    if (url.includes('/fs/preview')) {
      return json({
        type: 'text', content_type: 'text/markdown', content: '# API',
        file_size: 5, extension: '.md', relative_path: 'docs/api/README.md',
      })
    }
    if (url.includes('path=docs%2Fapi%2Finternal')) {
      return json({
        path: '/srv/demo/docs/api/internal', relative_path: 'docs/api/internal', name: 'internal',
        parent: '/srv/demo/docs/api', parent_relative_path: 'docs/api', entries: [],
      })
    }
    if (url.includes('path=docs%2Fapi')) {
      return json({
        path: '/srv/demo/docs/api', relative_path: 'docs/api', name: 'api',
        parent: '/srv/demo/docs', parent_relative_path: 'docs', entries: [{
          name: 'internal', type: 'directory', path: '/srv/demo/docs/api/internal',
          relative_path: 'docs/api/internal',
        }],
      })
    }
    if (url.includes('path=docs')) {
      return json({
        path: '/srv/demo/docs', relative_path: 'docs', name: 'docs',
        parent: '/srv/demo', parent_relative_path: '', entries: [{
          name: 'api', type: 'directory', path: '/srv/demo/docs/api', relative_path: 'docs/api',
        }],
      })
    }
    return json({
      path: '/srv/demo', relative_path: '', name: 'demo', parent: null,
      parent_relative_path: null, entries: [{
        name: 'docs', type: 'directory', path: '/srv/demo/docs', relative_path: 'docs',
      }],
    })
  }
  const root = createRoot(document.body.appendChild(document.createElement('div')))

  try {
    await act(async () => {
      root.render(<I18nProvider><ProjectDirectoryBrowser projectId="remote:one" /></I18nProvider>)
    })
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)) })

    const expandAll = document.querySelector<HTMLButtonElement>('[aria-label*="展开"], [aria-label*="Expand"]')
    assert.ok(expandAll)
    await act(async () => expandAll.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)) })
    assert.ok(requests.some((url) => url.includes('path=docs%2Fapi')))
    assert.ok(!requests.some((url) => url.includes('path=docs%2Fapi%2Finternal')))
    assert.equal(document.querySelector('[title="/srv/demo/docs"]')?.getAttribute('aria-expanded'), 'true')
    assert.equal(document.querySelector('[title="/srv/demo/docs/api"]')?.getAttribute('aria-expanded'), 'true')
    assert.equal(document.querySelector('[title="/srv/demo/docs/api/internal"]')?.getAttribute('aria-expanded'), 'false')

    const collapseAll = document.querySelector<HTMLButtonElement>('[aria-label*="收起"], [aria-label*="Collapse"]')
    assert.ok(collapseAll)
    await act(async () => collapseAll.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
    assert.equal(document.querySelector('[title="/srv/demo/docs"]')?.getAttribute('aria-expanded'), 'false')

    const search = document.querySelector<HTMLInputElement>('input[type="search"]')
    assert.ok(search)
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set
      valueSetter?.call(search, 'readme')
      search.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 250)) })
    assert.ok(requests.some((url) => url.includes('/fs/search') && !url.includes('include_hidden=true')))
    const result = document.querySelector<HTMLElement>('[data-search-result="true"]')
    assert.match(result?.textContent ?? '', /README\.md/)
    await act(async () => result?.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 0)) })
    assert.equal(document.querySelector('.markdown-message h1')?.textContent, 'API')

    const hiddenSwitch = document.querySelector<HTMLButtonElement>('[role="switch"]')
    assert.ok(hiddenSwitch)
    await act(async () => hiddenSwitch.dispatchEvent(new window.MouseEvent('click', { bubbles: true })))
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 250)) })
    assert.ok(requests.some((url) => url.includes('/fs/search') && url.includes('include_hidden=true')))
    assert.ok(Array.from(document.querySelectorAll<HTMLElement>('[data-search-result="true"]'))
      .some((entry) => entry.textContent?.includes('.readme')))

    const separator = document.querySelector<HTMLElement>('[role="separator"]')
    assert.ok(separator)
    const before = separator.getAttribute('aria-valuenow')
    await act(async () => separator.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })))
    assert.notEqual(separator.getAttribute('aria-valuenow'), before)
  } finally {
    await act(async () => root.unmount())
    globalThis.fetch = originalFetch
    await window.happyDOM.close()
  }
})
