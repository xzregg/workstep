import './helpers/domEnv.ts'

import assert from 'node:assert/strict'
import test from 'node:test'
import { act, useState, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'

import { fsApi } from '../src/api/client.ts'
import MarkdownEditor from '../src/components/MarkdownEditor.tsx'
import { I18nProvider, useLocaleStore } from '../src/i18n/index.tsx'

useLocaleStore.getState().setLocale('zh-CN')

const projectId = 'project-1'
const initial = '# 正文'
const imageFile = new File(['image'], 'picture.png', { type: 'image/png' })
const secondImage = new File(['image'], 'second.png', { type: 'image/png' })
const textFile = new File(['notes'], 'notes.txt', { type: 'text/plain' })

async function setup(props: Partial<ComponentProps<typeof MarkdownEditor>> = {}) {
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  let draft = initial
  function Editor() {
    const [value, setValue] = useState(initial)
    return <I18nProvider><MarkdownEditor projectId={projectId} imagePrefix="prefix" {...props}
      value={value} onChange={next => { draft = next; setValue(next) }} /></I18nProvider>
  }
  await act(async () => root.render(<Editor />))
  const actions = host.querySelector('.markdown-editor-actions')!
  return {
    host,
    actions,
    imageButton: actions.querySelector<HTMLButtonElement>('button[aria-label="添加图片"]'),
    imageInput: actions.querySelector<HTMLInputElement>('input[accept="image/*"]'),
    get draft() { return draft },
    async close() { await act(async () => root.unmount()); host.remove() },
  }
}

async function selectFiles(input: HTMLInputElement, files: File[]) {
  Object.defineProperty(input, 'files', { configurable: true, value: files })
  await act(async () => input.dispatchEvent(new window.Event('change', { bubbles: true })))
}

for (const mode of ['edit', 'preview']) {
  test(`the first editor action opens the image picker and uploads project images in ${mode} mode`, async (t) => {
    const upload = t.mock.method(fsApi, 'uploadImage', async (file: File) => ({
      url: `.workstep/uploads/${file.name}`,
    }))
    const ui = await setup()
    try {
      const buttons = [...ui.actions.querySelectorAll('button')]
      assert.deepEqual(buttons.map(button => button.getAttribute('aria-label')), [
        '添加图片', '上传附件', '预览 Markdown', '放大编辑器',
      ])
      assert.ok(ui.imageButton)
      assert.ok(ui.imageInput)
      assert.equal(ui.imageInput.multiple, true)
      const picker = t.mock.method(ui.imageInput, 'click', () => {})
      const preview = buttons[2]
      if (mode === 'preview') await act(async () => preview.click())
      else ui.host.querySelector('textarea')!.setSelectionRange(0, 0)
      await act(async () => ui.imageButton!.click())
      assert.equal(picker.mock.callCount(), 1)
      await selectFiles(ui.imageInput, [])
      assert.equal(ui.draft, initial)
      await selectFiles(ui.imageInput, [textFile])
      assert.equal(ui.draft, initial)
      await selectFiles(ui.imageInput, [imageFile, secondImage])
      assert.deepEqual(upload.mock.calls.map(call => call.arguments.slice(1)), [
        [projectId, 'prefix'], [projectId, 'prefix'],
      ])
      const references = '![picture.png](.workstep/uploads/picture.png)\n![second.png](.workstep/uploads/second.png)'
      assert.equal(ui.draft, mode === 'edit' ? references + '\n' + initial : initial + '\n' + references)
      if (mode === 'edit') await act(async () => preview.click())
      assert.equal(ui.host.querySelector('h1')?.textContent, '正文')
      assert.deepEqual([...ui.host.querySelectorAll('img')].map(img => img.alt), ['picture.png', 'second.png'])
    } finally { await ui.close() }
  })
}

test('image picker follows the existing project, permission and editor restrictions', async (t) => {
  const upload = t.mock.method(fsApi, 'uploadImage', async () => ({ url: '.workstep/uploads/picture.png' }))
  for (const props of [{ disabled: true }, { projectId: undefined }, { readOnly: true }, { allowAttachments: false }]) {
    const ui = await setup(props)
    try {
      if (props.readOnly || props.allowAttachments === false) {
        assert.equal(!!ui.imageButton || !!ui.imageInput, false)
      } else {
        assert.equal(ui.imageButton?.disabled, true)
        assert.equal(ui.imageInput?.disabled, true)
        await selectFiles(ui.imageInput!, [imageFile])
      }
      assert.equal(ui.draft, initial)
    } finally { await ui.close() }
  }

  window.history.replaceState(null, '', '/workspace/device')
  try {
    const ui = await setup()
    try {
      assert.equal(!!ui.imageButton || !!ui.imageInput, false)
    } finally { await ui.close() }
  } finally { window.history.replaceState(null, '', '/') }
  assert.equal(upload.mock.callCount(), 0)
})

test('generic attachment selection, paste and drop preserve trailing text when inserting mid-line', async (t) => {
  const uploadFile = t.mock.method(fsApi, 'uploadFile', async () => ({ url: '.workstep/uploads/notes.txt' }))
  const uploadImage = t.mock.method(fsApi, 'uploadImage', async () => ({ url: '.workstep/uploads/picture.png' }))
  const ui = await setup()
  try {
    const generic = ui.actions.querySelector<HTMLInputElement>('input[type="file"]:not([accept])')!
    const picker = t.mock.method(generic, 'click', () => {})
    await act(async () => ui.actions.querySelector<HTMLButtonElement>('button[aria-label="上传附件"]')!.click())
    assert.equal(picker.mock.callCount(), 1)
    const textarea = ui.host.querySelector('textarea')!
    const attachment = '[notes.txt](.workstep/uploads/notes.txt)'
    const image = '![picture.png](.workstep/uploads/picture.png)'
    const moveCaretBeforeText = () => {
      const position = ui.draft.indexOf('正文')
      textarea.setSelectionRange(position, position)
    }

    moveCaretBeforeText()
    await selectFiles(generic, [textFile])
    assert.equal(ui.draft, `# \n${attachment}正文`)

    const paste = new window.Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: { items: [{ kind: 'file', getAsFile: () => imageFile }] },
    })
    moveCaretBeforeText()
    await act(async () => textarea.dispatchEvent(paste))
    assert.equal(ui.draft, `# \n${attachment}\n${image}正文`)
    const drop = new window.Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [textFile] } })
    moveCaretBeforeText()
    await act(async () => ui.host.querySelector('.markdown-editor-shell')!.dispatchEvent(drop))
    assert.equal(ui.draft, `# \n${attachment}\n${image}\n${attachment}正文`)
    assert.equal(uploadFile.mock.callCount(), 2)
    assert.equal(uploadImage.mock.callCount(), 1)
    assert.equal(paste.defaultPrevented, true)
    assert.equal(drop.defaultPrevented, true)
  } finally { await ui.close() }
})
