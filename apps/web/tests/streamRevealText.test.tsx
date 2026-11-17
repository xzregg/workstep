import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import StreamRevealText from '../src/components/StreamRevealText'
import MarkdownContent from '../src/components/MarkdownContent'
import MarkdownMessage from '../src/components/MarkdownMessage'
import MessageTimeline from '../src/components/MessageTimeline'
import ChatMessageBubble from '../src/components/ChatMessageBubble'
import { MarkdownAssetUrlProvider } from '../src/contexts/MarkdownAssetUrlContext'
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
      content={'文 **强** [链](a) `i`\n\n```ts\nx\n```'}
      streaming animateReveal
    /></I18nProvider>))
    assert.ok(host.querySelector('strong .stream-reveal-char'))
    assert.ok(host.querySelector('a .stream-reveal-char'))
    assert.equal(host.querySelector('code .stream-reveal-char'), null)
    assert.equal(host.querySelector('pre code')?.textContent, 'x\n')
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
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)) })
    await render('你好世界')
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 110)) })
    assert.equal(host.textContent, '你好世界')
    // The previous characters have settled; only the new suffix needs animation.
    assert.ok(!host.contains(first))
    const tail = host.querySelector('.stream-reveal-char')
    await render('你好世界', false)
    assert.ok(host.contains(tail), 'completion must not interrupt the final fade')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)) })
    assert.equal(host.querySelector('.stream-reveal-char'), null)
    assert.equal(host.textContent, '你好世界')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})


test('unchanged visible Markdown does not reparse on parent token updates', async () => {
  const { window, document } = installDomEnvironment()
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  let resolutions = 0
  const onImageClick = () => {}
  const resolver = (src: string) => { resolutions++; return src }
  const render = (content: string) => act(async () => root.render(<I18nProvider>
    <MarkdownAssetUrlProvider resolver={resolver}>
      <MarkdownContent content={content} streaming onImageClick={onImageClick} />
    </MarkdownAssetUrlProvider>
  </I18nProvider>))
  try {
    await render('![图片](https://example.com/a.png)')
    const image = host.querySelector('img')
    await render('![图片](https://example.com/a.png)')
    assert.equal(host.querySelector('img'), image)
    assert.equal(resolutions, 1, 'unchanged visible content must skip Markdown parsing')
    await render('![图片](https://example.com/b.png)')
    assert.equal(resolutions, 2, 'new visible content still updates')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})


test('preloaded timeline text blooms later tokens without replaying existing text', async () => {
  const { window, document } = installDomEnvironment()
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const render = (content: string, streaming = true) => act(async () => root.render(
    <I18nProvider><MessageTimeline content={content} events={[]} streaming={streaming} /></I18nProvider>,
  ))
  try {
    await render('已有正文')
    assert.equal(host.querySelector('.stream-reveal-char'), null, 'first mounted content must not replay')
    const paragraph = host.querySelector('p')
    await render('已有正文新增字符')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 110)) })
    assert.equal(host.querySelector('p'), paragraph)
    assert.equal(host.textContent, '已有正文新增字符')
    assert.equal([...host.querySelectorAll('.stream-reveal-char')].map(node => node.textContent).join(''), '新增字符')
    const tail = host.querySelector('.stream-reveal-char')
    await render('已有正文新增字符', false)
    assert.ok(host.contains(tail), 'completion must retain the active tail')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)) })
    assert.equal(host.querySelector('.stream-reveal-char'), null)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})


test('completed bloom nodes are removed without reparsing Markdown or replaying old text', async () => {
  const { window, document } = installDomEnvironment()
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const render = (text: string) => act(async () => root.render(<StreamRevealText text={text} enabled />))
  try {
    await render('第一段新文字')
    assert.ok(host.querySelector('.stream-reveal-char'))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)) })
    assert.equal(host.querySelector('.stream-reveal-char'), null, 'finished animations must not accumulate through the full reply')
    assert.equal(host.textContent, '第一段新文字')
    await render('第一段新文字继续')
    assert.equal([...host.querySelectorAll('.stream-reveal-char')].map(node=>node.textContent).join(''), '继续')
    const range=document.createRange()
    range.selectNodeContents(host)
    window.getSelection()!.addRange(range)
    const selected = host.querySelector('.stream-reveal-char')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)) })
    assert.ok(host.contains(selected), 'cleanup must preserve selected text nodes')
    window.getSelection()!.removeAllRanges()
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)) })
    assert.equal(host.querySelector('.stream-reveal-char'), null)
    assert.equal(host.textContent, '第一段新文字继续')
  } finally {
    window.getSelection()!.removeAllRanges()
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})


test('a long burst limits bloom to the current message tail instead of animating every paragraph', async () => {
  const { window, document } = installDomEnvironment()
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const content=('正文 **强调** 与 [链接](https://example.com)，继续完整显示。\n\n').repeat(200)
  try {
    await act(async () => root.render(<I18nProvider><MarkdownContent content={content} streaming animateReveal /></I18nProvider>))
    const count=host.querySelectorAll('.stream-reveal-char').length
    assert.ok(count > 0 && count <= 32, `message-wide bloom budget exceeded: ${count}`)
    assert.equal(host.querySelectorAll('p').length, 200)
    assert.equal(host.querySelectorAll('a').length, 200)
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})


test('closing Markdown syntax never replays old text inside remounted inline nodes', async () => {
  const { window, document } = installDomEnvironment()
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const render = (content: string) => act(async () => root.render(<I18nProvider>
    <MarkdownContent content={content} streaming animateReveal />
  </I18nProvider>))
  try {
    await render('稳定正文 **之前的强调文字')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)) })
    await render('稳定正文 **之前的强调文字** 新字')
    const animated=[...host.querySelectorAll('.stream-reveal-char')].map(node=>node.textContent).join('')
    assert.ok(!animated.includes('之前') && !animated.includes('强调'), `old Markdown content replayed: ${animated}`)
    assert.ok(animated.includes('新字'), 'the actual new suffix should still animate')
    assert.equal(host.textContent, '稳定正文 之前的强调文字 新字')
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})

test('a multi-paragraph burst animates only its final text instead of paragraph endings throughout the message', async () => {
  const { window, document } = installDomEnvironment()
  const host = document.body.appendChild(document.createElement('div'))
  const root = createRoot(host)
  const content='前面的段落不应再闪动。\n\n'.repeat(20)+'只有最末尾的新字浮现。'
  try {
    await act(async () => root.render(<I18nProvider><MarkdownContent content={content} streaming animateReveal /></I18nProvider>))
    const animated=[...host.querySelectorAll('.stream-reveal-char')].map(node=>node.textContent).join('')
    assert.ok(animated.length <= 32, `tail animation exceeded its message-wide budget: ${animated.length}`)
    assert.equal(host.querySelector('p')?.querySelector('.stream-reveal-char'), null)
    assert.ok(animated.endsWith('只有最末尾的新字浮现。'))
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})


test('streaming uses a light opacity reveal without blur or glyph layout changes', () => {
  const css=readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
  const rule=css.match(/\.stream-reveal-char\s*\{([^}]+)\}/)![1]
  const keyframes=css.match(/@keyframes stream-reveal-bloom\s*\{([\s\S]*?)\n\}/)![1]
  assert.doesNotMatch(rule, /inline-block|white-space\s*:\s*pre/)
  assert.doesNotMatch(keyframes, /filter|blur|transform/)
  assert.match(keyframes, /opacity:\s*0/)
  assert.match(keyframes, /opacity:\s*1/)
  assert.match(rule, /320ms\s+linear/)
})


test('a new batch keeps the previous tail alive until its fade finishes', async () => {
  const { window, document } = installDomEnvironment()
  const host=document.body.appendChild(document.createElement('div'))
  const root=createRoot(host)
  const text='新'.repeat(60)
  try {
    await act(async () => root.render(<StreamRevealText text={text.slice(0,20)} enabled />))
    const first=host.querySelector('.stream-reveal-char')
    await act(async () => { await new Promise(resolve=>setTimeout(resolve,90)) })
    await act(async () => root.render(<StreamRevealText text={text.slice(0,40)} enabled />))
    assert.ok(host.contains(first), 'the next batch must not replace an unfinished fade with opaque text')
    assert.equal(host.textContent,text.slice(0,40))
  } finally {
    await act(async () => root.unmount())
    await window.happyDOM.close()
  }
})


for (const withEvents of [false,true]) test(`real message bubble reveals the first live paragraph instead of mounting it as restored history (events=${withEvents})`, async () => {
  const {window,document}=installDomEnvironment()
  const host=document.body.appendChild(document.createElement('div'))
  const root=createRoot(host)
  const text='这是刚刚收到的一整段实时正文，应该连续展开，不能一次显示整段。'.repeat(4)
  const render=(content:string)=>act(async()=>root.render(<I18nProvider><ChatMessageBubble
    role="assistant" sender="助手" initials="AI" color="#123456" content={content} streaming showLoading
    events={withEvents && content ? [{type:'TEXT_MESSAGE_CHUNK',delta:content}] : []}
  /></I18nProvider>))
  try {
    await render('')
    assert.equal(host.querySelector('.chat-bubble--assistant')?.hasAttribute('hidden'),true)
    assert.ok(host.querySelector('.engine-loading-message[role="status"]'))
    await render(text)
    assert.equal(host.querySelector('.chat-bubble--assistant')?.hasAttribute('hidden'),false)
    const body=()=>host.querySelector('.chat-bubble--assistant .markdown-message')?.textContent || ''
    assert.ok(body().length<text.length,'the first live paragraph must not bypass reveal')
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,110))})
    assert.ok(body().length>0 && body().length<text.length,'the first paragraph should be progressing')
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,550))})
    assert.equal(body(),text)
  } finally {
    await act(async()=>root.unmount())
    await window.happyDOM.close()
  }
})


for (const streaming of [false,true]) test(`restored real message bubble displays complete history immediately (streaming=${streaming})`, async () => {
  const {window,document}=installDomEnvironment()
  const host=document.body.appendChild(document.createElement('div'))
  const root=createRoot(host)
  const text='刷新后恢复的历史正文。'.repeat(100)
  try {
    await act(async()=>root.render(<I18nProvider><ChatMessageBubble
      role="assistant" sender="助手" initials="AI" color="#123456" content={text} streaming={streaming}
      events={[{type:'TEXT_MESSAGE_CHUNK',delta:text}]}
    /></I18nProvider>))
    assert.equal(host.querySelector('.chat-bubble--assistant .markdown-message')?.textContent,text)
    assert.ok(!host.querySelector('.stream-reveal-char'))
  } finally {
    await act(async()=>root.unmount())
    await window.happyDOM.close()
  }
})
