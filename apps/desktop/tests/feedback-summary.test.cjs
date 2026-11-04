const test = require('node:test')
const assert = require('node:assert/strict')
const { extractLogErrors, summarizeErrors } = require('../src/feedback-summary.mjs')

test('log extraction excludes normal records and keeps Python and JavaScript error context', () => {
  const logs = { 'daemon.log': [
    '2026-11-04T00:00:00.000Z error INFO: Application startup complete',
    '2026-11-04T00:00:01.000Z error Traceback (most recent call last):',
    '2026-11-04T00:00:01.001Z error   File "[path]", line 42, in run',
    '2026-11-04T00:00:01.002Z error     raise ValueError("bad input")',
    '2026-11-04T00:00:01.003Z error ValueError: bad input',
    '2026-11-04T00:00:02.000Z info ordinary operation',
  ].join('\n'), 'desktop.log': '2026-11-04T00:01:00.000Z error TypeError: broken\n    at render ([path]:12:3)\n2026-11-04T00:01:01.000Z info idle' }
  const summary = summarizeErrors(extractLogErrors(logs)).join('\n')
  assert.match(summary, /ValueError: bad input/)
  assert.match(summary, /line 42/)
  assert.match(summary, /TypeError: broken/)
  assert.match(summary, /:12:3/)
  assert.doesNotMatch(summary, /startup complete|ordinary operation|idle/)
})

test('summary deduplicates errors, selects the newest five and bounds long stacks', () => {
  const records = Array.from({ length: 10 }, (_, index) => ({ at: `2026-11-04T00:00:0${index}.000Z`, source: '页面', detail: `Error: failure-${index}\n${'    at frame ([path]:1:1)\n'.repeat(1000)}` }))
  records.push({ ...records[9], at: '2026-11-04T00:01:00.000Z' })
  const summary = summarizeErrors(records)
  assert.equal(summary.length, 5)
  assert.match(summary[0], /failure-9/)
  assert.ok(!summary.join('\n').includes('failure-0'))
  assert.equal(summary.join('\n').match(/failure-9/g).length, 1)
  assert.ok(Buffer.byteLength(summary.join('\n')) < 4 * 1024)
  assert.ok(summary.every(value => value.split('\n').length <= 4))
})

test('sandbox phase snapshots with no error never appear as errors', () => {
  const records = extractLogErrors({ 'sandbox-diagnostics.log': [
    '=== 沙箱启动阶段日志 ===',
    '{"time":"2026-11-04T00:00:00.000Z","phase":"running","error":null}',
    '{"time":"2026-11-04T00:01:00.000Z","phase":"error","error":"容器启动失败"}',
  ].join('\n'), 'desktop.log': '2026-11-04T00:00:00.000Z info 沙箱阶段 {"phase":"running","error":null}' })
  assert.equal(records.length, 1)
  assert.equal(records[0].detail, '容器启动失败')
})
