import './helpers/domEnv.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import MarkdownEditor from '../src/components/MarkdownEditor.tsx'
import { I18nProvider } from '../src/i18n/index.tsx'

const original = '# 原标题\n\n![图片](https://example.com/image.png)'

for (const locked of [undefined, 'readOnly', 'disabled'] as const) {
  test(`preview keeps the text editor and images with ${locked ?? 'editable'} input`, async () => {
    const host = document.body.appendChild(document.createElement('div'))
    const root = createRoot(host)
    function Editor() {
      const [value, setValue] = useState(original)
      return <I18nProvider><MarkdownEditor id="message" value={value} onChange={setValue}
        maxLength={500} readOnly={locked === 'readOnly'} disabled={locked === 'disabled'} /></I18nProvider>
    }
    try {
      await act(async () => root.render(<Editor />))
      const input = host.querySelector<HTMLTextAreaElement>('textarea')!
      const toggle = host.querySelector<HTMLButtonElement>('.markdown-editor-action[data-active]')!
      if (locked === 'disabled') {
        assert.equal(input.disabled, true)
        assert.equal(toggle.disabled, true)
        return
      }
      await act(async () => toggle.click())
      assert.equal(host.querySelector('textarea') === input, true)
      assert.equal(input.readOnly, locked === 'readOnly')
      assert.equal(input.id, 'message')
      assert.equal(input.maxLength, 500)
      assert.equal(host.querySelector('.markdown-editor-preview h1')?.textContent, '原标题')
      assert.equal(host.querySelector('.markdown-editor-preview img')?.getAttribute('src'), 'https://example.com/image.png')
      if (!locked) {
        await act(async () => {
          Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!.call(input, original.replace('原标题', '修改后'))
          input.dispatchEvent(new window.Event('input', { bubbles: true }))
        })
        assert.equal(host.querySelector('.markdown-editor-preview h1')?.textContent, '修改后')
        assert.equal(host.querySelectorAll('.markdown-editor-preview img').length, 1)
        await act(async () => toggle.click())
        assert.equal(input.value, original.replace('原标题', '修改后'))
        assert.equal(host.querySelector('.markdown-editor-preview') === null, true)
      }
    } finally {
      await act(async () => root.unmount())
      host.remove()
    }
  })
}
