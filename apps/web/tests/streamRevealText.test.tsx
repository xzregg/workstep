import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import StreamRevealText from '../src/components/StreamRevealText'
import MarkdownContent from '../src/components/MarkdownContent'
import MarkdownMessage from '../src/components/MarkdownMessage'
import { I18nProvider } from '../src/i18n'

test('only new characters bloom, with stable nodes and readable completed text', async () => {
  const { window, document } = installDomEnvironment()
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const render = (text: string, enabled = true) => act(async () => {
    root.render(<StreamRevealText text={text} enabled={enabled} />)
  })
  try {
    await render('你好')
    const first = host.querySelector('.stream-reveal-char')!
    assert.equal(host.querySelectorAll('.stream-reveal-char').length, 2)
    assert.ok(parseFloat((first.nextElementSibling as HTMLElement).style.animationDelay) <= 90)
    await render('你好世界')
    assert.equal(host.querySelector('.stream-reveal-char'), first)
    assert.equal(host.textContent, '你好世界')
    await render('替换后的文字', false)
    assert.equal(host.querySelector('.stream-reveal-char'), null)
    assert.equal(host.textContent, '替换后的文字')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('graphemes stay intact and large batches bound animation nodes', async () => {
  const { window, document } = installDomEnvironment()
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  try {
    await act(async () => root.render(<StreamRevealText text={'字'.repeat(5000) + '👨‍👩‍👧‍👦'} enabled />))
    assert.ok(host.querySelectorAll('.stream-reveal-char').length <= 32)
    for (const char of host.querySelectorAll<HTMLElement>('.stream-reveal-char')) {
      assert.ok(parseFloat(char.style.animationDelay) < 90, 'catch-up animation must fit within a render interval')
    }
    assert.equal(host.lastElementChild?.textContent, '👨‍👩‍👧‍👦')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('Markdown animates prose and links while leaving code intact', async () => {
  const { window, document } = installDomEnvironment()
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  try {
    await act(async () => root.render(<I18nProvider><MarkdownContent
      content={'正文 **强调** [链接](https://example.com) `inline`\n\n```ts\nconst n = 1\n```'}
      streaming animateReveal
    /></I18nProvider>))
    assert.ok(host.querySelector('strong .stream-reveal-char'))
    assert.ok(host.querySelector('a .stream-reveal-char'))
    assert.equal(host.querySelector('code .stream-reveal-char'), null)
    assert.equal(host.querySelector('pre code')?.textContent, 'const n = 1\n')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('restored running messages do not replay bloom animations', async () => {
  const { window, document } = installDomEnvironment()
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  try {
    await act(async () => root.render(<I18nProvider><MarkdownMessage content="已有正文" streaming /></I18nProvider>))
    assert.equal(host.querySelector('.stream-reveal-char'), null)
    assert.ok(host.textContent?.includes('已有正文'))
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('a new message blooms appended prose and clears the reveal layer on completion', async () => {
  const { window, document } = installDomEnvironment()
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const render = (content: string, streaming = true) => act(async () => {
    root.render(<I18nProvider><MarkdownMessage content={content} streaming={streaming} /></I18nProvider>)
  })
  try {
    await render('')
    await render('你好')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 110)) })
    assert.equal(host.querySelectorAll('.stream-reveal-char').length, 2)
    const first = host.querySelector('.stream-reveal-char')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 180)) })
    await render('你好世界')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 110)) })
    assert.equal(host.textContent, '你好世界')
    // The previous characters have settled; only the new suffix needs animation.
    assert.ok(!host.contains(first))
    await render('你好世界', false)
    assert.equal(host.querySelector('.stream-reveal-char'), null)
    assert.equal(host.textContent, '你好世界')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})
