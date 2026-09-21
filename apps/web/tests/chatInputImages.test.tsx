// Must stay first: react-dom snapshots DOM availability when it is imported.
import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { useState } from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import ChatInput from '../src/components/ChatInput'
import { I18nProvider } from '../src/i18n'

const firstImage = '![one](.workstep/uploads/one.png)'
const secondImage = '![two](.workstep/uploads/two.png)'

function Harness({
  initial,
  onChange,
  imageAttach,
}: {
  initial: string
  onChange: (value: string) => void
  imageAttach?: React.ComponentProps<typeof ChatInput>['imageAttach']
}) {
  const [value, setValue] = useState(initial)
  return (
    <I18nProvider>
      <ChatInput
        value={value}
        onChange={(next) => {
          setValue(next)
          onChange(next)
        }}
        onSend={() => {}}
        imageAttach={imageAttach}
      />
    </I18nProvider>
  )
}

test('composer keeps consecutive images in one visual row and backspace removes the adjacent image', async () => {
  const { window } = installDomEnvironment()
  const changes: string[] = []
  let root!: Root

  try {
    const container = window.document.body.appendChild(window.document.createElement('div'))
    await act(async () => {
      root = createRoot(container as never)
      root.render(<Harness initial={`${firstImage}\n\n${secondImage}`} onChange={(value) => changes.push(value)} />)
      await Promise.resolve()
    })

    assert.equal(container.querySelectorAll('.chat-input-image-block').length, 2)
    assert.equal(
      Array.from(container.querySelectorAll('textarea')).some((element) => element.value === '\n\n'),
      false,
      'blank markdown separators between images must not force a separate row',
    )

    const finalTextarea = Array.from(container.querySelectorAll('textarea')).at(-1) as HTMLTextAreaElement
    finalTextarea.setSelectionRange(0, 0)
    await act(async () => {
      finalTextarea.dispatchEvent(new window.KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Backspace',
      }))
    })

    assert.equal(changes.at(-1), firstImage)
    assert.equal(container.querySelectorAll('.chat-input-image-block').length, 1)

    await act(async () => { root.unmount() })
  } finally {
    await window.happyDOM.close()
  }
})

test('pasting an image inserts it at the caret without adding line breaks', async () => {
  const { window } = installDomEnvironment()
  const changes: string[] = []
  let root!: Root

  try {
    const container = window.document.body.appendChild(window.document.createElement('div'))
    await act(async () => {
      root = createRoot(container as never)
      root.render(
        <Harness
          initial="前后"
          onChange={(value) => changes.push(value)}
          imageAttach={{
            upload: async () => ({
              url: '.workstep/uploads/shot.png',
              filename: 'shot.png',
              size: 3,
            }),
          }}
        />,
      )
      await Promise.resolve()
    })

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    textarea.setSelectionRange(1, 1)
    await act(async () => {
      textarea.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })

    const file = new window.File(['png'], 'shot.png', { type: 'image/png' })
    const pasteEvent = new window.Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: {
        items: [{ kind: 'file', getAsFile: () => file }],
      },
    })
    await act(async () => {
      textarea.dispatchEvent(pasteEvent)
      await Promise.resolve()
      await Promise.resolve()
    })

    assert.equal(changes.at(-1), '前![shot.png](.workstep/uploads/shot.png)后')
    assert.doesNotMatch(changes.at(-1) ?? '', /\n/)

    await act(async () => { root.unmount() })
  } finally {
    await window.happyDOM.close()
  }
})

test('delete removes an image immediately after the caret', async () => {
  const { window } = installDomEnvironment()
  const changes: string[] = []
  let root!: Root

  try {
    const container = window.document.body.appendChild(window.document.createElement('div'))
    await act(async () => {
      root = createRoot(container as never)
      root.render(<Harness initial={`说明${firstImage}`} onChange={(value) => changes.push(value)} />)
      await Promise.resolve()
    })

    const firstTextarea = container.querySelector('textarea') as HTMLTextAreaElement
    firstTextarea.setSelectionRange(firstTextarea.value.length, firstTextarea.value.length)
    await act(async () => {
      firstTextarea.dispatchEvent(new window.KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'Delete',
      }))
    })

    assert.equal(changes.at(-1), '说明')
    assert.equal(container.querySelectorAll('.chat-input-image-block').length, 0)

    await act(async () => { root.unmount() })
  } finally {
    await window.happyDOM.close()
  }
})

test('caret navigation crosses an inline image without a visual line break', async () => {
  const { window } = installDomEnvironment()
  let root!: Root

  try {
    const container = window.document.body.appendChild(window.document.createElement('div'))
    await act(async () => {
      root = createRoot(container as never)
      root.render(<Harness initial={`前${firstImage}后`} onChange={() => {}} />)
      await Promise.resolve()
    })

    const textareas = Array.from(container.querySelectorAll('textarea')) as HTMLTextAreaElement[]
    const imageButton = container.querySelector('.chat-input-image') as HTMLButtonElement
    assert.equal(textareas.length, 2)
    assert.ok(textareas.every((element) => element.classList.contains('chat-input-text-segment--inline')))

    await act(async () => {
      textareas[0].focus()
      textareas[0].setSelectionRange(textareas[0].value.length, textareas[0].value.length)
      textareas[0].dispatchEvent(new window.KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'ArrowRight',
      }))
    })
    assert.equal(window.document.activeElement, imageButton)

    await act(async () => {
      imageButton.dispatchEvent(new window.KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        key: 'ArrowRight',
      }))
    })
    assert.equal(window.document.activeElement, textareas[1])
    assert.equal(textareas[1].selectionStart, 0)

    await act(async () => { root.unmount() })
  } finally {
    await window.happyDOM.close()
  }
})
