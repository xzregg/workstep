import assert from 'node:assert/strict'
import test from 'node:test'

import { getAssistantLabel } from '../src/pages/AgentAssistantSettings.tsx'
import { zhCNT } from '../src/i18n/index.tsx'

test('assistant settings translates channel chat and keeps unknown names readable', () => {
  assert.equal(getAssistantLabel('channel_chat', zhCNT), '渠道回复')
  assert.equal(getAssistantLabel('prototype', zhCNT), '原型编辑')
  assert.equal(getAssistantLabel('chat_session', zhCNT), '普通对话')
  assert.equal(getAssistantLabel('future_assistant', zhCNT), 'future_assistant')
})
