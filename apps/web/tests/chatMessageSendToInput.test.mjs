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
  new URL('../src/components/TaskDetailView.tsx', import.meta.url),
  'utf8',
)

test('user messages expose a send action beside copy that fills the composer', () => {
  assert.match(bubbleSource, /onSendToInput\?: \(content: string\) => void/)
  assert.match(bubbleSource, /onClick=\{\(\) => onSendToInput\(content\)\}/)
  assert.match(bubbleSource, /<Icon name="send"/)

  const sendActionIndex = bubbleSource.indexOf('onClick={() => onSendToInput(content)}')
  const copyActionIndex = bubbleSource.indexOf('<MessageCopyButton content={content}')
  assert.ok(sendActionIndex !== -1 && sendActionIndex < copyActionIndex)

  assert.match(assistantPanelSource, /onSendToInput=\{\(content\) => \{/)
  assert.match(assistantPanelSource, /onInputChange\(content\)/)
  assert.match(taskDetailSource, /onSendToInput=\{/)
  assert.match(taskDetailSource, /onPromptChange\(content\)/)
})
