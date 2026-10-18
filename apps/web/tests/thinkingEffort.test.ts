import assert from 'node:assert/strict'
import test from 'node:test'
import { engineConfigOptionLabel, engineEffortOptions } from '../src/utils/thinkingEffort'
import { zhCNT } from '../src/i18n'
import type { EngineConfigField } from '../src/api/engine'

const field: EngineConfigField = {
  key: 'model_reasoning_effort', label: '推理强度', type: 'select',
  model_capability: 'supported_reasoning_efforts',
  options: ['auto', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']
    .map(value => ({ value, label: value })),
  placeholder: '', required: false, help: '', default: '', sensitive: false, confirm_values: [],
}
test('effort choices use the complete engine schema without a model catalog', () => {
  assert.deepEqual(engineEffortOptions({ config: { fields: [field] } }), field.options)
  assert.deepEqual(engineEffortOptions({ config: { fields: [], step_fields: [field] } }), field.options)
})

test('custom engines supply their own configuration choices without engine-id branches', () => {
  const custom = { ...field, key: 'thinking_effort', model_capability: '', options: [{ value: 'brief', label: '简短' }, { value: 'deep', label: '深入' }] }
  assert.deepEqual(engineEffortOptions({ config: { fields: [custom] } }), custom.options)
  assert.deepEqual(engineEffortOptions({ config: { fields: [], step_fields: [custom] } }), custom.options)
})

test('legacy effort labels translate without changing custom labels or unrelated fields', () => {
  for (const key of ['thinking_effort', 'model_reasoning_effort', 'reasoning_effort']) {
    const legacy = { ...field, key, model_capability: undefined }
    assert.equal(engineConfigOptionLabel(legacy, { value: 'medium', label: 'medium' }, zhCNT), '中')
    assert.equal(engineConfigOptionLabel(legacy, { value: 'low', label: '快速' }, zhCNT), '快速')
  }
  assert.equal(engineConfigOptionLabel({ ...field, key: 'custom_mode', model_capability: undefined },
    { value: 'low', label: 'low' }, zhCNT), 'low')
})
