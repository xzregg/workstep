import './helpers/domEnv.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import MarkdownEditor from '../src/components/MarkdownEditor.tsx'
import { I18nProvider } from '../src/i18n/index.tsx'

const image = '![图片](.workstep/uploads/example.png)'
const original = `# 标题\n\n原文字 **强调**\n\n${image}`

async function setup(props: { readOnly?: boolean; maxLength?: number; initial?: string } = {}) {
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  let draft = props.initial ?? original
  let changeExternal: (value: string) => void = () => {}
  function Editor() {
    const [value, setValue] = useState(props.initial ?? original)
    changeExternal = setValue
    return <I18nProvider><MarkdownEditor value={value} onChange={next => { draft = next; setValue(next) }}
      projectId="project-1" {...props} /></I18nProvider>
  }
  await act(async () => root.render(<Editor />))
  const toggle = host.querySelector<HTMLButtonElement>('.markdown-editor-action[data-active]')!
  await act(async () => toggle.click())
  return { host, toggle, async external(next: string) { draft = next; await act(async () => changeExternal(next)) }, get draft() { return draft }, async close() { await act(async () => root.unmount()); host.remove() } }
}

async function inputText(node: HTMLElement, text: string) {
  await act(async () => {
    node.focus()
    node.textContent = text
    node.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

test('edits rendered prose in the original preview without a source area and keeps images and formatting', async () => {
  const ui = await setup()
  try {
    assert.equal(ui.host.querySelector('textarea') === null, true)
    const editor = ui.host.querySelector<HTMLElement>('.markdown-editor-preview [contenteditable="true"]')!
    assert.ok(editor)
    const imageNode = ui.host.querySelector('img')!
    const source = imageNode.getAttribute('src')
    await inputText(editor, '新标题')
    assert.equal(ui.draft.includes('# 新标题'), true)
    assert.equal(ui.draft.includes(image), true)
    assert.equal(ui.draft.includes('**强调**'), true)
    assert.equal(ui.host.querySelector('img') === imageNode, true)
    assert.equal(imageNode.getAttribute('src'), source)
    await act(async () => editor.blur())
    await act(async () => ui.toggle.click())
    assert.equal(ui.host.querySelector<HTMLTextAreaElement>('textarea')?.value, ui.draft)
    await act(async () => ui.toggle.click())
    assert.equal(ui.host.querySelector('h1')?.textContent, '新标题')
    assert.equal(ui.host.querySelectorAll('img').length, 1)
  } finally { await ui.close() }
})

test('preview respects read-only and length limits', async () => {
  const ui = await setup({ readOnly: true })
  try {
    assert.equal(ui.host.querySelector('[contenteditable="true"]') === null, true)
    assert.equal(ui.host.querySelectorAll('img').length, 1)
  } finally { await ui.close() }
  const limited = await setup({ maxLength: original.length })
  try {
    const editor = limited.host.querySelector<HTMLElement>('[contenteditable="true"]')!
    assert.ok(editor)
    await inputText(editor, '超长文字'.repeat(100))
    assert.equal(limited.draft, original)
    assert.equal(editor.textContent, '标题')
  } finally { await limited.close() }
})

test('typed Markdown and HTML characters remain literal visible text after redisplay', async () => {
  const ui = await setup()
  try {
    const editor = ui.host.querySelector<HTMLElement>('[contenteditable="true"]')!
    assert.ok(editor)
    await inputText(editor, '**文字** <script> & [链接](bad)')
    await act(async () => editor.blur())
    await act(async () => ui.toggle.click())
    await act(async () => ui.toggle.click())
    assert.equal(ui.host.querySelector('h1')?.textContent, '**文字** <script> & [链接](bad)')
    assert.equal(ui.host.querySelector('script') === null, true)
    assert.equal(ui.host.querySelectorAll('img').length, 1)
  } finally { await ui.close() }
})

for (const initial of ['', image, '长文字'.repeat(900) + '\n\n' + image]) {
  test(`empty, image-only and long previews can insert prose (${initial.length})`, async () => {
    const ui = await setup({ initial })
    try {
      const editor = ui.host.querySelector<HTMLElement>('[contenteditable="true"]')!
      assert.ok(editor)
      await inputText(editor, '新内容')
      await act(async () => editor.blur())
      await act(async () => ui.toggle.click())
      await act(async () => ui.toggle.click())
      assert.match(ui.host.querySelector('.markdown-editor-preview')?.textContent ?? '', /新内容/)
      assert.equal(ui.draft.includes(image), initial.includes(image))
      assert.equal(ui.host.querySelectorAll('img').length, initial.includes(image) ? 1 : 0)
    } finally { await ui.close() }
  })
}

test('edits across multiple formatted spans retain source offsets and Chinese composition', async () => {
  const ui = await setup()
  try {
    const spans = [...ui.host.querySelectorAll<HTMLElement>('[contenteditable="true"]')]
    await inputText(spans[0], '更长的新标题')
    await inputText(spans[2], '更强的强调')
    await act(async () => {
      spans[2].dispatchEvent(new window.CompositionEvent('compositionstart', { bubbles: true }))
      spans[2].textContent = '中文输入完成'
      spans[2].dispatchEvent(new window.CompositionEvent('compositionend', { bubbles: true }))
    })
    await act(async () => spans[2].blur())
    await act(async () => ui.toggle.click())
    await act(async () => ui.toggle.click())
    assert.equal(ui.host.querySelector('h1')?.textContent, '更长的新标题')
    assert.equal(ui.host.querySelector('strong')?.textContent, '中文输入完成')
    assert.equal(ui.draft.includes(image), true)
  } finally { await ui.close() }
})

test('external draft changes during focus do not lose uploaded images on the next keystroke', async () => {
  const ui = await setup()
  try {
    const editor = ui.host.querySelector<HTMLElement>('[contenteditable="true"]')!
    await inputText(editor, '第一次编辑')
    const secondImage = '![新图](.workstep/uploads/new.png)'
    await ui.external(ui.draft + '\n\n' + secondImage)
    const refreshed = ui.host.querySelector<HTMLElement>('[contenteditable="true"]')!
    await inputText(refreshed, '继续编辑')
    await act(async () => refreshed.blur())
    assert.equal(ui.draft.includes(image), true)
    assert.equal(ui.draft.includes(secondImage), true)
    assert.equal(ui.host.querySelectorAll('img').length, 2)
  } finally { await ui.close() }
})
