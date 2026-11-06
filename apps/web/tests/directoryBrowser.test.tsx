import './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { fsApi } from '../src/api/client'
import DirectoryBrowser from '../src/components/DirectoryBrowser'

for (const fails of [false, true]) {
  test(`creating a folder ${fails ? 'preserves selection on failure' : 'automatically selects the returned directory'}`, async () => {
    const { document, window } = installDomEnvironment()
    useLocaleStore.setState({ locale: 'zh-CN' })
    const originalBrowse = fsApi.browse
    const originalMkdir = fsApi.mkdir
    let created = false
    const selections: string[] = []
    fsApi.browse = async () => ({
      path: '/workspace', parent: '/', entries: [
        { name: 'existing', path: '/workspace/existing', type: 'directory' },
        ...(created ? [{ name: 'new', path: '/workspace/new', type: 'directory' as const }] : []),
      ],
    })
    fsApi.mkdir = async (parent, name) => {
      assert.equal(parent, '/workspace')
      assert.equal(name, 'new')
      if (fails) throw new Error('创建失败')
      created = true
      return { path: '/workspace/new', name: 'new' }
    }
    function Harness() {
      const [path, setPath] = useState('/workspace/existing')
      return <DirectoryBrowser selectedPath={path} onSelect={value => { selections.push(value); setPath(value) }} />
    }
    const root = createRoot(document.body.appendChild(document.createElement('div')))
    try {
      await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
      await act(async () => [...document.querySelectorAll('button')].find(b => b.textContent?.includes('新建文件夹'))!.click())
      await act(async () => {
        const input = document.querySelector('input')!
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'new')
        input.dispatchEvent(new window.Event('input', { bubbles: true }))
      })
      await act(async () => [...document.querySelectorAll('button')].find(b => b.textContent === '创建')!.click())
      assert.deepEqual(selections, fails ? [] : ['/workspace/new'])
      assert.equal(document.querySelector('[aria-selected="true"]')?.textContent?.trim(), fails ? '📁existing' : '📁new')
      if (fails) assert.match(document.body.textContent || '', /创建失败/)
      else assert.equal(document.querySelector('input'), null)
    } finally {
      await act(async () => root.unmount())
      fsApi.browse = originalBrowse
      fsApi.mkdir = originalMkdir
      await window.happyDOM.close()
    }
  })
}
