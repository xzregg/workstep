import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test, { mock } from 'node:test'
import { readFileSync } from 'node:fs'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import StreamRevealText from '../src/components/StreamRevealText'
import MarkdownContent from '../src/components/MarkdownContent'
import ChatMessageBubble from '../src/components/ChatMessageBubble'
import { MarkdownAssetUrlProvider } from '../src/contexts/MarkdownAssetUrlContext'
import { I18nProvider } from '../src/i18n'

function frameClock() {
  let time=0, id=0
  const frames=new Map<number,FrameRequestCallback>()
  const clock=mock.method(performance,'now',()=>time)
  globalThis.requestAnimationFrame=callback=>{frames.set(++id,callback);return id}
  globalThis.cancelAnimationFrame=key=>{frames.delete(key)}
  return {
    async advance(next:number) {
      time=next
      await act(async()=>{const pending=[...frames.values()];frames.clear();for(const callback of pending)callback(time)})
    },
    get size(){return frames.size},
    restore(){clock.mock.restore()},
  }
}

test('new glyphs append to the same native text node without replaying or reshaping its prefix', async () => {
  const {window,document}=installDomEnvironment()
  const clock=frameClock(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
  const render=(text:string,enabled=true)=>act(async()=>root.render(<StreamRevealText text={text} enabled={enabled} animateInitial={false}/>))
  try {
    const prefix='已有文字 AVATAR typography '
    await render(prefix)
    const node=host.firstChild
    await render(prefix+'甲乙丙丁')
    assert.ok(host.firstChild===node)
    assert.equal(host.childNodes.length,1)
    assert.equal(host.textContent,prefix)
    await clock.advance(0)
    assert.equal(host.textContent,prefix+'甲','the first glyph should appear on the next paint')
    await clock.advance(30)
    assert.equal(host.textContent,prefix+'甲乙')
    await render(prefix+'甲乙丙丁戊己庚辛')
    assert.equal(host.textContent,prefix+'甲乙','new chunks must not flush the previous pending suffix')
    await clock.advance(90)
    assert.equal(host.textContent,prefix+'甲乙丙丁戊己')
    await clock.advance(180)
    assert.equal(host.textContent,prefix+'甲乙丙丁戊己庚辛')
    assert.ok(host.firstChild===node)
    assert.equal(host.querySelector('span'),null)
    assert.equal(clock.size,0,'settled replies must not leave frame loops running')
    await render('替换的正文',false)
    assert.equal(host.textContent,'替换的正文')
  } finally {
    await act(async()=>root.unmount());clock.restore();await window.happyDOM.close()
  }
})

test('large batches reveal only the bounded tail and never split graphemes', async () => {
  const {window,document}=installDomEnvironment()
  const clock=frameClock(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
  const text='字'.repeat(5000)+'👨‍👩‍👧‍👦'
  try {
    await act(async()=>root.render(<StreamRevealText text={text} enabled/>))
    assert.equal(host.textContent,'字'.repeat(4969))
    await clock.advance(86)
    assert.equal(host.textContent,'字'.repeat(5000),'the family emoji must remain whole')
    await clock.advance(90)
    assert.equal(host.textContent,text)
    assert.equal(host.childNodes.length,1)
    assert.equal(clock.size,0)
  } finally {
    await act(async()=>root.unmount());clock.restore();await window.happyDOM.close()
  }
})

test('an append that extends the preceding grapheme never leaves a truncated glyph', async () => {
  const {window,document}=installDomEnvironment()
  const clock=frameClock(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
  const render=(text:string)=>act(async()=>root.render(<StreamRevealText text={text} enabled/>))
  try {
    await render('e')
    await render('é')
    assert.equal(host.textContent,'é')
    await clock.advance(180)
    assert.equal(host.textContent,'é')
    assert.equal(clock.size,0)
  } finally {
    await act(async()=>root.unmount());clock.restore();await window.happyDOM.close()
  }
})

test('selecting a partially revealed text node freezes its remaining suffix', async () => {
  const {window,document}=installDomEnvironment()
  const clock=frameClock(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
  try {
    await act(async()=>root.render(<StreamRevealText text="甲乙丙丁" enabled/>))
    await clock.advance(30)
    const node=host.firstChild,range=document.createRange()
    range.selectNodeContents(host)
    window.getSelection()!.addRange(range)
    await clock.advance(90)
    assert.equal(host.textContent,'甲乙')
    assert.ok(host.firstChild===node)
    assert.equal(window.getSelection()!.toString(),'甲乙')
  } finally {
    window.getSelection()!.removeAllRanges()
    await act(async()=>root.unmount());clock.restore();await window.happyDOM.close()
  }
})

test('reduced motion and unmount stop leaf frame work', async () => {
  const {window,document}=installDomEnvironment()
  const clock=frameClock(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
  const media=mock.method(window,'matchMedia',()=>({matches:true}) as MediaQueryList)
  try {
    await act(async()=>root.render(<StreamRevealText text="立即显示" enabled/>))
    assert.equal(host.textContent,'立即显示')
    assert.equal(clock.size,0)
    media.mock.restore()
    await act(async()=>root.render(<StreamRevealText text="立即显示后续文字" enabled/>))
    assert.equal(clock.size,1)
    await act(async()=>root.unmount())
    assert.equal(clock.size,0)
  } finally {
    media.mock.restore();clock.restore();await window.happyDOM.close()
  }
})

test('Markdown reveals prose and link labels while code remains intact', async () => {
  const {window,document}=installDomEnvironment()
  const clock=frameClock(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
  try {
    await act(async()=>root.render(<I18nProvider><MarkdownContent content={'文 **强** [链](a) `i`\n\n```ts\nx\n```'} streaming animateReveal/></I18nProvider>))
    assert.ok(host.querySelector('strong'))
    assert.ok(host.querySelector('a'))
    assert.equal(host.querySelector('pre code')?.textContent,'x\n')
    await clock.advance(90)
    assert.equal(host.querySelector('strong')?.textContent,'强')
    assert.equal(host.querySelector('a')?.textContent,'链')
    assert.equal(host.querySelector('.stream-reveal-char'),null)
  } finally {
    await act(async()=>root.unmount());clock.restore();await window.happyDOM.close()
  }
})

test('closing Markdown syntax preserves old visible text in remounted inline nodes', async () => {
  const {window,document}=installDomEnvironment()
  const clock=frameClock(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
  const render=(content:string)=>act(async()=>root.render(<I18nProvider><MarkdownContent content={content} streaming animateReveal/></I18nProvider>))
  try {
    await render('稳定正文 **之前的强调文字')
    await clock.advance(90)
    await render('稳定正文 **之前的强调文字** 新字')
    assert.equal(host.querySelector('strong')?.textContent,'之前的强调文字')
    assert.ok(host.textContent?.startsWith('稳定正文 之前的强调文字'))
    await clock.advance(180)
    assert.equal(host.textContent,'稳定正文 之前的强调文字 新字')
  } finally {
    await act(async()=>root.unmount());clock.restore();await window.happyDOM.close()
  }
})

test('large multi-paragraph snapshots reveal only the final source window', async () => {
  const {window,document}=installDomEnvironment()
  const clock=frameClock(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
  const content=('正文 **强调** 与 [链接](https://example.com)，继续完整显示。\n\n').repeat(200)
  try {
    await act(async()=>root.render(<I18nProvider><MarkdownContent content={content} streaming animateReveal/></I18nProvider>))
    assert.equal(host.querySelectorAll('p').length,200)
    assert.equal(host.querySelectorAll('a').length,200)
    assert.equal(host.querySelector('p')?.textContent,'正文 强调 与 链接，继续完整显示。')
    assert.ok(clock.size<=3,'only the final source window may request animation frames')
    await clock.advance(90)
    assert.equal(clock.size,0)
  } finally {
    await act(async()=>root.unmount());clock.restore();await window.happyDOM.close()
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
    // The outer parse interval commits first; the leaf then schedules its frame.
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,110))})
    assert.ok(body().length>0 && body().length<text.length,'the first paragraph should be progressing')
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,1600))})
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,110))})
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




test('the streaming caret never switches paragraphs or headings to inline layout', () => {
  const css=readFileSync(new URL('../src/index.css',import.meta.url),'utf8')
  assert.doesNotMatch(css,/\.markdown-message\.is-streaming[^{}]+\{\s*display:\s*inline;/)
  assert.match(css,/nth-last-child\(2\)::after/,'the caret belongs inside the existing block')
  assert.doesNotMatch(css,/\.stream-reveal-char\s*\{/,'old glyphs must not acquire animation paint groups')
})
