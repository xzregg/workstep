import assert from 'node:assert/strict'
import test from 'node:test'

import type { EngineConfigPayload } from '../src/api/client'
import {
  initialStageConfig,
  normalizeStepConfig,
  setStageFieldValue,
  stageFieldValue,
} from '../src/utils/stageConfig.ts'

const payload: EngineConfigPayload = {
  fields: [
    {
      key: 'api_key', label: 'API Key', type: 'password', placeholder: '',
      options: null, required: false, help: '', default: '',
      sensitive: true, confirm_values: [],
    },
  ],
  stage_fields: [
    {
      key: 'permission_mode', label: '权限模式', type: 'select', placeholder: '',
      options: [{ value: 'acceptEdits', label: 'Accept Edits' }],
      required: false, help: '', default: '', sensitive: false, confirm_values: ['bypassPermissions'],
    },
    {
      key: 'model_reasoning_effort', label: '推理强度', type: 'select', placeholder: '',
      options: [{ value: 'high', label: 'High' }],
      required: false, help: '', default: '', sensitive: false, confirm_values: [],
    },
  ],
  values: { api_key: 'sk-123', permission_mode: 'acceptEdits', model_reasoning_effort: 'high' },
  secrets: { api_key: true },
}

test('initialStageConfig prefills stage fields from global values and skips sensitive fields', () => {
  const config = initialStageConfig(payload)
  assert.deepEqual(config, {
    permission_mode: 'acceptEdits',
    model_reasoning_effort: 'high',
  })
  assert.equal(config.api_key, undefined)
})

test('initialStageConfig returns {} for missing payload', () => {
  assert.deepEqual(initialStageConfig(null), {})
  assert.deepEqual(initialStageConfig(undefined), {})
})

test('initialStageConfig skips empty global values', () => {
  const empty: EngineConfigPayload = {
    ...payload,
    values: { permission_mode: '', model_reasoning_effort: 'high' },
  }
  assert.deepEqual(initialStageConfig(empty), { model_reasoning_effort: 'high' })
})

test('stageFieldValue returns the stored value or empty string', () => {
  const field = payload.stage_fields[0]
  assert.equal(stageFieldValue({ permission_mode: 'bypassPermissions' }, field), 'bypassPermissions')
  assert.equal(stageFieldValue({}, field), '')
})

test('setStageFieldValue updates a key and drops empty values', () => {
  const field = payload.stage_fields[0]
  const next = setStageFieldValue({}, field, 'acceptEdits')
  assert.deepEqual(next, { permission_mode: 'acceptEdits' })
  const cleared = setStageFieldValue(next, field, '')
  assert.deepEqual(cleared, {})
})

test('normalizeStepConfig round-trips stored config and coerces scalar values', () => {
  assert.deepEqual(normalizeStepConfig(
    { permission_mode: 'acceptEdits', max_retries: 3, enabled: true, empty: '' },
  ), {
    permission_mode: 'acceptEdits',
    max_retries: '3',
    enabled: 'true',
  })

  assert.deepEqual(normalizeStepConfig(null), {})
  assert.deepEqual(normalizeStepConfig('nope'), {})
  assert.deepEqual(normalizeStepConfig(['a', 'b']), {})
})
