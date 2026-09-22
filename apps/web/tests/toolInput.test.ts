import assert from 'node:assert/strict'
import test from 'node:test'

import { extractToolTarget } from '../src/utils/toolInput.ts'

test('complete object input extracts the file target as complete', () => {
  const info = extractToolTarget({ path: 'apps/web/src/main.tsx', content: 'x' })
  assert.equal(info.fileTarget, 'apps/web/src/main.tsx')
  assert.equal(info.searchTarget, '')
  assert.equal(info.targetComplete, true)
  assert.ok(info.record)
})

test('complete JSON string input extracts the file target as complete', () => {
  const info = extractToolTarget(JSON.stringify({ file_path: 'src/app/main.py' }))
  assert.equal(info.fileTarget, 'src/app/main.py')
  assert.equal(info.targetComplete, true)
})

test('concatenated JSON fragments merge and expose the file target', () => {
  const source = JSON.stringify({ path: 'a.ts' }) + JSON.stringify({ path: 'b.ts' })
  const info = extractToolTarget(source)
  // Later fragments win, matching object-update semantics.
  assert.equal(info.fileTarget, 'b.ts')
  assert.equal(info.targetComplete, true)
})

test('truncated JSON with a closed path string still yields a complete file target', () => {
  const info = extractToolTarget('{"path":"apps/web/src/main.tsx","old_string":"')
  assert.equal(info.fileTarget, 'apps/web/src/main.tsx')
  assert.equal(info.targetComplete, true)
})

test('truncated JSON with an unclosed path yields no file target', () => {
  const info = extractToolTarget('{"path":"apps/web/src/mai')
  assert.equal(info.fileTarget, '')
  assert.equal(info.targetComplete, false)
})

test('escaped path segments survive decoding', () => {
  const info = extractToolTarget('{"path":"docs/a\\"b.ts","x":"')
  assert.equal(info.fileTarget, 'docs/a"b.ts')
  assert.equal(info.targetComplete, true)
})

test('file and search keys are kept apart', () => {
  const both = extractToolTarget({ path: 'ignored.ts', pattern: 'tests/foo.test.ts' })
  assert.equal(both.fileTarget, 'ignored.ts')
  assert.equal(both.searchTarget, 'tests/foo.test.ts')
  assert.equal(both.target, 'ignored.ts')

  const searchOnly = extractToolTarget({ pattern: 'tests/foo.test.ts' })
  assert.equal(searchOnly.fileTarget, '')
  assert.equal(searchOnly.searchTarget, 'tests/foo.test.ts')
})

test('read_tool_result-style input never yields a file target from pattern', () => {
  const info = extractToolTarget({
    handle: '01a075ae-8b3f-7463-a8ee-cd668e679ff3/call_45bce20d.0',
    offset: 0,
    limit: 200,
    pattern: 'fail',
  })
  assert.equal(info.fileTarget, '')
  assert.equal(info.searchTarget, 'fail')
})

test('empty / non-object inputs yield no targets', () => {
  for (const value of [undefined, null, '', '   ', 42, true, ['array'], '"just a string"']) {
    const info = extractToolTarget(value)
    assert.equal(info.fileTarget, '')
    assert.equal(info.searchTarget, '')
    assert.equal(info.targetComplete, false)
  }
})

test('non-object JSON string falls back to fragment/regex extraction', () => {
  const info = extractToolTarget('"just a string" + {"path":"x.ts"}')
  assert.equal(info.fileTarget, 'x.ts')
  assert.equal(info.targetComplete, true)
})
