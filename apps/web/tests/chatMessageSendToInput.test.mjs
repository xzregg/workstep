import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const bubbleSource = fs.readFileSync(
  new URL('../src/components/ChatMessageBubble.tsx', import.meta.url),
  'utf8',
)
const assistantPanelSource = fs.readFileSync(
  new URL('../src/components/AssistantChatPanel.tsx', import.meta.url),
  'utf8',
)
const taskDetailSource = fs.readFileSync(
  new URL('../src/components/TaskConversationMessage.tsx', import.meta.url),
  'utf8',
)

test('user messages expose a send action beside copy that fills the composer', () => {
  assert.match(bubbleSource, /onSendToInput\?: \(content: string\) => void/)
  assert.match(bubbleSource, /onClick=\{\(\) => onSendToInput\(content\)\}/)
  assert.match(bubbleSource, /<Icon name="send"/)

  const sendActionIndex = bubbleSource.indexOf('onClick={() => onSendToInput(content)}')
  const copyActionIndex = bubbleSource.indexOf('<MessageCopyButton content={content}')
  assert.ok(sendActionIndex !== -1 && sendActionIndex < copyActionIndex)

  // 面板把回调收敛为稳定引用（useCallback）再传给 memo 化的 MessageItem：
  // 流式输出时历史消息靠引用相等整体跳过重渲染，内联箭头会击穿 memo。
  assert.match(assistantPanelSource, /const handleSendToInput = useCallback\(\(content: string\) => \{/)
  assert.match(assistantPanelSource, /onSendToInput=\{handleSendToInput\}/)
  assert.match(assistantPanelSource, /const MessageItem = memo\(function MessageItem/)
  assert.match(assistantPanelSource, /onInputChange\(content\)/)
  assert.match(taskDetailSource, /onSendToInput=\{/)
  assert.match(taskDetailSource, /onPromptChange\(content\)/)
})
