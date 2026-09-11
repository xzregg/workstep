import assert from 'node:assert/strict'
import test from 'node:test'

import { getAssistantLabel } from '../src/pages/SettingsPage.tsx'
import { zhCNT } from '../src/i18n/index.tsx'

test('assistant settings translates channel chat and keeps unknown names readable', () => {
  assert.equal(getAssistantLabel('channel_chat', zhCNT), '渠道对话')
  assert.equal(getAssistantLabel('future_assistant', zhCNT), 'future_assistant')
})
