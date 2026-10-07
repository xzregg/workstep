import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/utils/slashSkills.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
const { applySlashInputItem, slashInputQuery } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
)
const chatInputSource = await readFile(new URL('../src/components/ChatInput.tsx', import.meta.url), 'utf8')
const assistantPanelSource = await readFile(new URL('../src/components/AssistantChatPanel.tsx', import.meta.url), 'utf8')
const taskDetailSource = await readFile(new URL('../src/components/TaskDetailView.tsx', import.meta.url), 'utf8')
const chatPageSource = await readFile(new URL('../src/pages/ChatPage.tsx', import.meta.url), 'utf8')
const flowChatSource = await readFile(new URL('../src/components/AiFlowChat.tsx', import.meta.url), 'utf8')
const taskChatSource = await readFile(new URL('../src/components/AiTaskCreateChat.tsx', import.meta.url), 'utf8')

test('detects a slash skill query at the cursor', () => {
  assert.equal(slashInputQuery('/', 1), '')
  assert.equal(slashInputQuery('/rev', 4), null)
  assert.equal(slashInputQuery('说明\n/', 4), '')
  assert.equal(slashInputQuery('请使用/', 4), '')
  assert.equal(slashInputQuery('前文/后文', 3), '')
  assert.equal(slashInputQuery('请使用 /rev', 8), null)
  assert.equal(slashInputQuery('/rev later', 10), null)
})

test('uses the invocation text returned by the current engine', () => {
  assert.deepEqual(applySlashInputItem('/', 1, {
    insert_text: '$deploy ',
  }), {
    value: '$deploy ',
    cursor: 8,
  })
  assert.deepEqual(applySlashInputItem('说明\n/', 4, {
    insert_text: '/review ',
  }), {
    value: '说明\n/review ',
    cursor: 11,
  })
})

test('shared chat input loads engine-owned input items and executes their actions', () => {
  assert.match(chatInputSource, /engineApi\.inspect\(effectiveEngine, projectId\)/)
  assert.match(chatInputSource, /result\.input_items/)
  assert.match(chatInputSource, /role="listbox"/)
  assert.match(chatInputSource, /event\.key === 'ArrowDown'/)
  assert.match(chatInputSource, /event\.key === 'Enter' \|\| event\.key === 'Tab'/)
  assert.match(chatInputSource, /case 'toggle_plan'/)
  assert.match(chatInputSource, /case 'open_model'/)
  assert.match(chatInputSource, /case 'open_reasoning'/)
  assert.match(chatInputSource, /case 'show_status'/)
  assert.match(assistantPanelSource, /projectId=\{projectId\}/)
  assert.match(assistantPanelSource, /availableCommands=\{availableCommands\}/)
  assert.match(chatPageSource, /availableCommands=\{session\?\.availableCommands\}/)
  assert.match(flowChatSource, /availableCommands=\{session\?\.availableCommands\}/)
  assert.match(taskChatSource, /availableCommands=\{session\?\.availableCommands\}/)
  assert.match(taskDetailSource, /projectId=\{projectId\}/)
  assert.match(taskDetailSource, /skillEngine=\{chatTarget === 'coordinator'/)
  assert.match(taskDetailSource, /availableCommands=\{availableCommands\?\./)
})
