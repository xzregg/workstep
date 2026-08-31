import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/pages/SchedulePage.tsx', import.meta.url), 'utf8')

test('renders task configuration before scheduling configuration', () => {
  const taskConfiguration = source.indexOf("t('taskList.contentTab')")
  const schedulingConfiguration = source.indexOf("t('schedules.frequency')")
  const saveAction = source.indexOf("t('common.save')")

  assert.ok(taskConfiguration >= 0, 'task configuration is present')
  assert.ok(schedulingConfiguration > taskConfiguration, 'scheduling configuration follows task configuration')
  assert.ok(saveAction > schedulingConfiguration, 'save action remains after scheduling configuration')
})

test('uses the reference frequency tabs and derives the schedule name from the effective task title', () => {
  assert.match(source, /schedules\.frequencyCycle/)
  assert.match(source, /schedules\.frequencyInterval/)
  assert.match(source, /schedules\.frequencyOnce/)
  assert.doesNotMatch(source, /<Field label=\{t\('schedules\.name'\)\}>/)
  assert.match(source, /const derivedTitle = title\.trim\(\) \|\| `\$\{description\.trim\(\)\.slice\(0, 10\)\}\.\.\.`/)
  assert.match(source, /: derivedTitle,/)
  assert.doesNotMatch(source, /!title\.trim\(\) \|\| !workflowId/)
})

test('uses the program timezone without exposing a timezone field', () => {
  assert.match(source, /Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone/)
  assert.doesNotMatch(source, /<Field label=\{t\('schedules\.timezone'\)\}>/)
})

test('opens without selecting a schedule and reveals the editor only on demand', () => {
  assert.match(source, /const \[creating, setCreating\] = useState\(false\)/)
  assert.match(source, /\? current : null/)
  assert.match(source, /\{\(selected \|\| creating\) && \(<>/)
})

test('renders a one-time schedule summary on two lines', () => {
  assert.match(source, /function ScheduleSummary/)
  assert.match(source, /<br \/>/)
  assert.match(source, /<ScheduleSummary summary=\{item\.summary\} \/>/)
})
