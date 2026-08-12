import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildInteractionResponse,
  cancelInteractionResponse,
  interactionForm,
  interactionItemsFromEvents,
  mergeInteractionEvents,
  pendingInteractionItems,
  permissionDecision,
  type InteractionRequestData,
} from '../src/utils/interaction.ts'

test('permission request renders ACP options as a required single choice', () => {
  const request: InteractionRequestData = {
    interaction_id: 'permission-1',
    method: 'session/request_permission',
    tool_call: { tool_call_id: 'tool-1', title: '运行测试' },
    options: [
      { option_id: 'once', name: '仅允许一次', kind: 'allow_once' },
      { option_id: 'deny', name: '拒绝', kind: 'reject_once' },
    ],
  }

  assert.deepEqual(interactionForm(request), {
    id: 'permission-1',
    title: '运行测试',
    fields: [{
      id: 'permission',
      title: '是否允许这项操作？',
      description: '',
      type: 'single',
      required: true,
      allowInput: false,
      options: [
        { value: 'once', label: '仅允许一次', description: '', kind: 'allow_once' },
        { value: 'deny', label: '拒绝', description: '', kind: 'reject_once' },
      ],
    }],
  })
})

test('elicitation schema renders multi-choice and free text fields', () => {
  const request: InteractionRequestData = {
    interaction_id: 'ask-1',
    method: 'elicitation/create',
    message: '需要确认两项信息',
    requested_schema: {
      type: 'object',
      required: ['scope', 'note'],
      properties: {
        scope: {
          type: 'array',
          title: '范围',
          description: '可多选',
          items: { oneOf: [
            { const: 'backend', title: '后端' },
            { const: 'web', title: '前端' },
          ] },
          _meta: { allowInput: true },
        },
        note: {
          type: 'string',
          title: '补充',
          description: '请输入补充说明',
          _meta: { allowInput: true },
        },
      },
    },
  }

  const form = interactionForm(request)
  assert.equal(form.title, '需要确认两项信息')
  assert.equal(form.fields[0].type, 'multiple')
  assert.equal(form.fields[0].allowInput, true)
  assert.equal(form.fields[1].type, 'text')
  assert.equal(form.fields[1].required, true)
})

test('permission decision picks least-privilege allow/deny options', () => {
  const request: InteractionRequestData = {
    interaction_id: 'permission-1',
    method: 'session/request_permission',
    tool_call: { tool_call_id: 'tool-1', title: '运行测试' },
    options: [
      { option_id: 'always', name: '始终允许', kind: 'allow_always' },
      { option_id: 'once', name: '仅允许一次', kind: 'allow_once' },
      { option_id: 'deny-once', name: '拒绝', kind: 'reject_once' },
      { option_id: 'deny-always', name: '始终拒绝', kind: 'reject_always' },
    ],
  }

  assert.deepEqual(permissionDecision(request, true), {
    outcome: { outcome: 'selected', option_id: 'once' },
  })
  assert.deepEqual(permissionDecision(request, false), {
    outcome: { outcome: 'selected', option_id: 'deny-once' },
  })
})

test('permission decision falls back to cancelled when no matching option', () => {
  const request: InteractionRequestData = {
    interaction_id: 'permission-2',
    method: 'session/request_permission',
    tool_call: { tool_call_id: 'tool-1' },
    options: [{ option_id: 'deny', name: '拒绝', kind: 'reject_once' }],
  }

  assert.deepEqual(permissionDecision(request, true), {
    outcome: { outcome: 'cancelled' },
  })
  assert.deepEqual(permissionDecision(request, false), {
    outcome: { outcome: 'selected', option_id: 'deny' },
  })
})

test('builds native ACP responses for permission and elicitation', () => {
  const permissionRequest: InteractionRequestData = {
    interaction_id: 'permission-1',
    method: 'session/request_permission',
    tool_call: { tool_call_id: 'tool-1' },
    options: [{ option_id: 'once', name: '允许', kind: 'allow_once' }],
  }
  const permission = buildInteractionResponse(permissionRequest, { permission: 'once' })
  assert.deepEqual(permission, {
    outcome: { outcome: 'selected', option_id: 'once' },
  })

  const elicitationRequest: InteractionRequestData = {
    interaction_id: 'ask-1',
    method: 'elicitation/create',
    requested_schema: { type: 'object', properties: {} },
  }
  const elicitation = buildInteractionResponse(
    elicitationRequest,
    { scope: ['backend', 'web'], note: '保持兼容' },
  )
  assert.deepEqual(elicitation, {
    action: 'accept',
    content: { scope: ['backend', 'web'], note: '保持兼容' },
  })

  assert.deepEqual(cancelInteractionResponse(permissionRequest), {
    outcome: { outcome: 'cancelled' },
  })
  assert.deepEqual(cancelInteractionResponse(elicitationRequest), {
    action: 'cancel',
  })
})

test('pairs persisted interaction requests with their responses', () => {
  const items = interactionItemsFromEvents([
    { type: 'interaction_request', data: {
      interaction_id: 'ask-1', method: 'elicitation/create',
      requested_schema: { type: 'object', properties: {} },
    } },
    { type: 'interaction_request', data: {
      interaction_id: 'permission-1', method: 'session/request_permission',
      tool_call: { tool_call_id: 'tool-1' }, options: [],
    } },
    { type: 'interaction_response', data: {
      interaction_id: 'ask-1', response: {
        action: 'accept', content: { answer: '继续' },
      },
    } },
  ])

  assert.equal(items.length, 2)
  assert.deepEqual(items[0].response, {
    action: 'accept', content: { answer: '继续' },
  })
  assert.equal(items[1].response, undefined)
})

test('drops answered interaction cards so they disappear after acting', () => {
  const items = pendingInteractionItems([
    { type: 'interaction_request', data: {
      interaction_id: 'permission-1', method: 'session/request_permission',
      tool_call: { tool_call_id: 'tool-1' },
      options: [
        { option_id: 'once', name: '允许一次', kind: 'allow_once' },
        { option_id: 'always', name: '允许所有', kind: 'allow_always' },
      ],
    } },
    { type: 'interaction_request', data: {
      interaction_id: 'ask-1', method: 'elicitation/create',
      requested_schema: { type: 'object', properties: {} },
    } },
    { type: 'interaction_response', data: {
      interaction_id: 'permission-1',
      response: { outcome: { outcome: 'selected', option_id: 'once' } },
    } },
  ])

  assert.equal(items.length, 1)
  assert.equal(items[0].request.interaction_id, 'ask-1')
})

test('preserves persisted interaction requests across partial live updates', () => {
  const events = mergeInteractionEvents(
    [{ type: 'interaction_request', data: {
      interaction_id: 'ask-1', method: 'elicitation/create',
    } }],
    [{ type: 'interaction_response', data: {
      interaction_id: 'ask-1', response: { action: 'accept', content: {} },
    } }],
  )

  assert.deepEqual(events.map((event) => event.type), [
    'interaction_request',
    'interaction_response',
  ])
})
