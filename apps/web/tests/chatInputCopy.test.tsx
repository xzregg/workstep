// Must stay first: react-dom snapshots DOM availability when it is imported.
import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import ChatInput from '../src/components/ChatInput'
import { I18nProvider } from '../src/i18n'

function StatefulComposer({ initial }: { initial: string }) {
  const [value, setValue] = useState(initial)
  return (
    <I18nProvider>
      <ChatInput value={value} onChange={setValue} onSend={() => {}} />
    </I18nProvider>
  )
}

test('select all copies the complete composer value including image markdown', async () => {
  const { window } = installDomEnvironment()
  const value = '开头\n\n![截图](.workstep/uploads/shot.png)\n\n结尾'
  const clipboard = new Map<string, string>()
  let root!: Root

  try {
    const container = window.document.body.appendChild(window.document.createElement('div'))
    await act(async () => {
      root = createRoot(container as never)
      root.render(
        <I18nProvider>
          <ChatInput value={value} onChange={() => {}} onSend={() => {}} />
        </I18nProvider>,
      )
      await Promise.resolve()
    })

    const firstTextarea = container.querySelector('textarea') as HTMLTextAreaElement
    const editor = container.querySelector('.chat-input-editor') as HTMLElement
    const image = container.querySelector('.chat-input-image-block') as HTMLElement
    assert.ok(firstTextarea && editor && image, 'composer renders split text and image segments')

    await act(async () => {
      firstTextarea.dispatchEvent(new window.KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'a',
        metaKey: true,
      }))
    })

    assert.equal(editor.dataset.allSelected, 'true')

    const copyEvent = new window.Event('copy', { bubbles: true, cancelable: true })
    Object.defineProperty(copyEvent, 'clipboardData', {
      value: { setData: (type: string, content: string) => clipboard.set(type, content) },
    })
    firstTextarea.dispatchEvent(copyEvent)

    assert.equal(copyEvent.defaultPrevented, true)
    assert.equal(clipboard.get('text/plain'), value)
    assert.equal(image.closest('[data-all-selected="true"]'), editor)

    await act(async () => { root.unmount() })
  } finally {
    await window.happyDOM.close()
  }
})

test('delete clears all text and images after selecting the complete composer', async () => {
  const { window } = installDomEnvironment()
  const value = '开头![截图](.workstep/uploads/shot.png)结尾'
  let root!: Root

  try {
    const container = window.document.body.appendChild(window.document.createElement('div'))
    await act(async () => {
      root = createRoot(container as never)
      root.render(<StatefulComposer initial={value} />)
      await Promise.resolve()
    })

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      textarea.dispatchEvent(new window.KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'a',
        ctrlKey: true,
      }))
      textarea.dispatchEvent(new window.KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Delete',
      }))
    })

    assert.equal(container.querySelectorAll('.chat-input-image-block').length, 0)
    assert.equal((container.querySelector('textarea') as HTMLTextAreaElement).value, '')
    assert.equal((container.querySelector('.chat-input-editor') as HTMLElement).dataset.allSelected, undefined)

    await act(async () => { root.unmount() })
  } finally {
    await window.happyDOM.close()
  }
})

test('undo restores text and images removed by select-all delete', async () => {
  const { window } = installDomEnvironment()
  const value = '开头![截图](.workstep/uploads/shot.png)结尾'
  let root!: Root

  try {
    const container = window.document.body.appendChild(window.document.createElement('div'))
    await act(async () => {
      root = createRoot(container as never)
      root.render(<StatefulComposer initial={value} />)
      await Promise.resolve()
    })

    let textarea = container.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      textarea.dispatchEvent(new window.KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'a',
        metaKey: true,
      }))
      textarea.dispatchEvent(new window.KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Backspace',
      }))
    })
    assert.equal(container.querySelectorAll('.chat-input-image-block').length, 0)

    textarea = container.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      textarea.dispatchEvent(new window.KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'z',
        metaKey: true,
      }))
    })

    assert.equal(container.querySelectorAll('.chat-input-image-block').length, 1)
    assert.equal(
      Array.from(container.querySelectorAll('textarea')).map((element) => element.value).join(''),
      '开头结尾',
    )

    await act(async () => { root.unmount() })
  } finally {
    await window.happyDOM.close()
  }
})
