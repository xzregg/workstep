// Must stay first: react-dom snapshots DOM support during module evaluation.
import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import QuickPromptButton from '../src/components/QuickPromptButton'

test('quick prompt renders safe HTML links and accepts an empty prompt', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let selected: string | null = null

  try {
    await act(async () => root.render(
      <QuickPromptButton
        label={'<a href="https://example.com" onclick="alert(1)"><strong>打开文档</strong></a><script>alert(2)</script>'}
        prompt=""
        onSelect={(prompt) => { selected = prompt }}
      />,
    ))

    const link = container.querySelector<HTMLAnchorElement>('a')
    assert.ok(link)
    assert.equal(link.textContent, '打开文档')
    assert.equal(link.href, 'https://example.com/')
    assert.equal(link.target, '_blank')
    assert.equal(link.rel, 'noopener noreferrer')
    assert.equal(link.hasAttribute('onclick'), false)
    assert.equal(container.querySelector('script'), null)

    await act(async () => link.click())
    assert.equal(selected, null)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

test('quick prompt still selects non-HTML labels', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let selected = ''

  try {
    await act(async () => root.render(
      <QuickPromptButton label="解释" prompt="请解释" onSelect={(prompt) => { selected = prompt }} />,
    ))
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
    assert.equal(selected, '请解释')
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

test('display-only quick button renders safe HTML without an executable button', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  let selected = false
  try {
    await act(async () => root.render(
      <QuickPromptButton
        label={'<strong>说明</strong><img src=x onerror=alert(1)>'}
        prompt=""
        displayOnly
        onSelect={() => { selected = true }}
      />,
    ))
    assert.equal(container.querySelector('button'), null)
    assert.equal(container.querySelector('img'), null)
    assert.equal(container.textContent, '说明')
    await act(async () => container.click())
    assert.equal(selected, false)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})

test('display button shows its title but renders HTML from content', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(
      <QuickPromptButton
        label="开发地址"
        prompt=""
        displayOnly
        displayContent={'<a href="http://localhost:5173" onclick="alert(1)">打开前端</a>'}
        onSelect={() => {}}
      />,
    ))
    assert.match(container.textContent || '', /开发地址/)
    const link = container.querySelector<HTMLAnchorElement>('a')!
    assert.equal(link.textContent, '打开前端')
    assert.equal(link.hasAttribute('onclick'), false)
    assert.equal(container.querySelector('button'), null)
  } finally {
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
