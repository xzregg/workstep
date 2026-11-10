import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { Window } from 'happy-dom'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import MarkdownMessage from '../src/components/MarkdownMessage'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { MarkdownAssetUrlProvider } from '../src/contexts/MarkdownAssetUrlContext'

test('local screenshot paths remain readable without image or resolver requests in Markdown and plain text', async () => {
  const window = new Window({ url: 'http://localhost/' })
  Object.assign(globalThis, {window, document:window.document, navigator:window.navigator,
    HTMLElement:window.HTMLElement, IS_REACT_ACT_ENVIRONMENT:true})
  useLocaleStore.getState().setLocale('zh-CN')
  const container=document.body.appendChild(document.createElement('div')); const root=createRoot(container)
  let resolved=0
  try {
    for (const plainText of [false,true]) {
      for (const path of ['/tmp/workstep-local-gateway-connected.jpg', '/private/tmp/screen.jpg', '/Users/demo/screen.jpg', 'file:///tmp/screen.jpg', 'C:/Users/demo/screen.jpg', '/%74mp/screen.jpg']) {
        await act(async()=>root.render(<I18nProvider><MarkdownAssetUrlProvider resolver={src=>{resolved++;return '/workspace/device'+src}}>
          <MarkdownMessage content={`![连接截图](${path})`} plainText={plainText}/>
        </MarkdownAssetUrlProvider></I18nProvider>))
        assert.equal(container.querySelector('img'),null,path)
        assert.equal(container.querySelector('.markdown-image-click'),null,path)
        assert.match(container.textContent??'',/本机文件.*上传/)
        assert.ok(container.textContent?.includes(path))
      }
    }
    assert.equal(resolved,0)
    await act(async()=>root.render(<I18nProvider><MarkdownMessage content="![远程截图](https://example.com/tmp/screen.jpg) ![接口图片](/api/fs/serve/screen.jpg)"/></I18nProvider>))
    assert.equal(container.querySelectorAll('img').length,2)
  } finally {await act(async()=>root.unmount());await window.happyDOM.close()}
})

test('shared Markdown images open and close the image preview by default', async () => {
  useLocaleStore.getState().setLocale('zh-CN')
  const window = new Window({ url: 'http://localhost/' })
  Object.assign(globalThis, {
    window,
    document: window.document,
    navigator: window.navigator,
    HTMLElement: window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)

  try {
    const styles = document.head.appendChild(document.createElement('style'))
    styles.textContent = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
    await act(async () => root.render(
      <I18nProvider>
        <MarkdownMessage content={'![界面截图](.workstep/uploads/screen.png)'} projectId="project-1" />
      </I18nProvider>,
    ))
    const thumbnail = container.querySelector<HTMLButtonElement>('.markdown-image-click')
    assert.ok(thumbnail)
    const thumbnailStyle = window.getComputedStyle(thumbnail.querySelector('img')!)
    assert.equal(thumbnailStyle.maxWidth, 'min(100%, 320px)')
    assert.equal(thumbnailStyle.maxHeight, '240px')
    assert.equal(thumbnailStyle.width, 'auto')
    assert.equal(thumbnailStyle.height, 'auto')
    assert.equal(window.getComputedStyle(thumbnail).maxWidth, '100%')
    await act(async () => thumbnail.click())
    const preview = document.querySelector<HTMLElement>('.image-preview')
    assert.ok(preview)
    assert.equal(preview.querySelector('img')?.getAttribute('src'), thumbnail.querySelector('img')?.getAttribute('src'))
    await act(async () => window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })))
    assert.equal(document.querySelector('.image-preview'), null)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})


test('project filesystem images use scoped file delivery locally and through the gateway', async () => {
  const window = new Window({ url: 'http://localhost/' })
  Object.assign(globalThis, {window, document:window.document, navigator:window.navigator,
    HTMLElement:window.HTMLElement, IS_REACT_ACT_ENVIRONMENT:true})
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    for (const gateway of [false, true]) {
      window.happyDOM.setURL(gateway ? 'https://gateway.test/workspace/device/chat' : 'http://localhost/chat')
      for (const plainText of [false, true]) {
        for (const path of ['/data/projects/三国塔防小程序/research/game-screenshots/Thronefall/1.png', '/Users/demo/project/screen.png', 'research/Peglin/1.jpg']) {
          await act(async () => root.render(<I18nProvider><MarkdownMessage content={`![实机截图](${path})`} projectId="project-1" plainText={plainText}/></I18nProvider>))
          const img = container.querySelector('img')
          assert.ok(img, path)
          const url = new URL(img.getAttribute('src')!, window.location.origin)
          assert.equal(url.pathname, (gateway ? '/workspace/device' : '') + '/api/fs/file')
          assert.equal(url.searchParams.get('project_id'), 'project-1')
          assert.equal(url.searchParams.get('path'), path)
          await act(async () => container.querySelector<HTMLButtonElement>('.markdown-image-click')!.click())
          assert.equal(document.querySelector('.image-preview img')?.getAttribute('src'), img.getAttribute('src'))
          await act(async () => window.dispatchEvent(new window.KeyboardEvent('keydown', {key:'Escape'})))
        }
      }
    }
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})
