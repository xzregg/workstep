import React, { useLayoutEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import MarkdownMessage from '../../src/components/MarkdownMessage'
import ResponsiveNavigation from '../../src/components/ResponsiveNavigation'
import ChatInput from '../../src/components/ChatInput'
import ChatMessageBubble from '../../src/components/ChatMessageBubble'
import MessageMetaBar from '../../src/components/MessageMetaBar'
import MessageResponseFooter from '../../src/components/MessageResponseFooter'
import { followConversationBottom, disposeConversationFollow } from '../../src/utils/smoothConversationFollow'
import { I18nProvider } from '../../src/i18n'

const demo = window as any
demo.WorkStepAndroid = {}
demo.sent = []
const patterns = {
  list: '- 列表项\n  - 嵌套 **强调** 与 English words。\n\n',
  quote: '> 引用 **强调** 与 English words。\n> 后续引用\n\n',
  table: '| 标题 | 内容 |\n| --- | --- |\n' + '| 行 | 值 **强调** |\n'.repeat(100),
  code: '~~~ts\n' + 'const value = 123;\n'.repeat(2000),
  live: '流式回复中的中文段落、**重点**和 English words。\n\n',
}
type Chunk = { type: 'TEXT_MESSAGE_CHUNK'; delta: string; timestamp: string }
function App() {
  const [text, setText] = useState('')
  const [draft, setDraft] = useState('')
  const [running, setRunning] = useState(true)
  const [events, setEvents] = useState<Chunk[]>([])
  const transcript = useRef<HTMLElement>(null)
  const programmatic = useRef(0)
  const following = useRef(true)
  useLayoutEffect(() => {
    const list = transcript.current!
    const observer = new ResizeObserver(() => {
      if (following.current) followConversationBottom(list, programmatic, following)
    })
    observer.observe(list.firstElementChild!)
    return () => { observer.disconnect(); disposeConversationFollow(list) }
  }, [])
  demo.start = (kind: keyof typeof patterns) => {
    const source = patterns[kind].repeat(kind === 'code' ? 1 : 1000)
    let length = 24000
    setText(source.slice(0, length))
    const chunk = (delta: string): Chunk => ({ type: 'TEXT_MESSAGE_CHUNK', delta, timestamp: new Date().toISOString() })
    if (kind === 'live') setEvents(source.slice(0, length).match(/[\s\S]{1,12}/g)!.map(chunk))
    const timer = setInterval(() => {
      const next = length + 8
      if (kind === 'live') {
        const event = chunk(source.slice(length, next))
        setEvents(events => [...events, event].slice(-2000))
      }
      length = next
      setText(source.slice(0, length))
    }, kind === 'live' ? 12 : 40)
    demo.stop = () => {
      clearInterval(timer)
      setText(source.slice(0, length) + (kind === 'code' ? '\n~~~' : '') + '\n\n终点确认')
      setRunning(false)
    }
  }
  return <I18nProvider><MemoryRouter>
    <ResponsiveNavigation className="layout-sidebar" title="演示会话" onNew={() => {}}>
      <div className="layout-sidebar-header">演示会话</div>
    </ResponsiveNavigation>
    <main ref={transcript} className="chat-history-scroll chat-history-scroll--assistant chat-history-scroll--paged">
      <div className="chat-history-content chat-history-content--assistant">{events.length ? <ChatMessageBubble
      role="assistant" sender="助手" initials="AI" content={text} streaming={running} events={events}
      header={<MessageMetaBar events={events} running={running} onViewPrompt={() => {}} />}
      footer={<MessageResponseFooter content={text} events={events} running={running} engine="codex_sdk" />}
    /> : <MarkdownMessage content={text} streaming={running}/>}</div></main>
    <footer id="stream-composer"><ChatInput value={draft} onChange={setDraft}
      onSend={() => { demo.sent.push(draft); setDraft('') }}
      running={running} allowSendWhileRunning connectorsEnabled={false}/></footer>
  </MemoryRouter></I18nProvider>
}
createRoot(document.getElementById('root')!).render(<App/> )
