import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import MarkdownMessage from '../../src/components/MarkdownMessage'
import ResponsiveNavigation from '../../src/components/ResponsiveNavigation'
import ChatInput from '../../src/components/ChatInput'
import { I18nProvider } from '../../src/i18n'

const demo = window as any
demo.WorkStepAndroid = {}
demo.sent = []
const patterns = {
  list: '- 列表项\n  - 嵌套 **强调** 与 English words。\n\n',
  quote: '> 引用 **强调** 与 English words。\n> 后续引用\n\n',
  table: '| 标题 | 内容 |\n| --- | --- |\n' + '| 行 | 值 **强调** |\n'.repeat(100),
  code: '~~~ts\n' + 'const value = 123;\n'.repeat(2000),
}
function App() {
  const [text, setText] = useState('')
  const [draft, setDraft] = useState('')
  const [running, setRunning] = useState(true)
  demo.start = (kind: keyof typeof patterns) => {
    const source = patterns[kind].repeat(kind === 'code' ? 1 : 1000)
    let length = 24000
    setText(source.slice(0, length))
    const timer = setInterval(() => { length += 8; setText(source.slice(0, length)) }, 40)
    demo.stop = () => {
      clearInterval(timer)
      setText(source.slice(0, length) + (kind === 'code' ? '\n~~~' : '') + '\n\n终点确认')
      setRunning(false)
    }
  }
  return <I18nProvider><MemoryRouter>
    <ResponsiveNavigation title="演示会话" onNew={() => {}}><p>操作手册演示</p></ResponsiveNavigation>
    <main><MarkdownMessage content={text} streaming={running}/></main>
    <footer><ChatInput value={draft} onChange={setDraft}
      onSend={() => { demo.sent.push(draft); setDraft('') }}
      running={running} allowSendWhileRunning connectorsEnabled={false}/></footer>
  </MemoryRouter></I18nProvider>
}
createRoot(document.getElementById('root')!).render(<App/> )
