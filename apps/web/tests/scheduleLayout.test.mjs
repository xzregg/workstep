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

test('uses the reference frequency tabs and derives the schedule name from the task title', () => {
  assert.match(source, /schedules\.frequencyCycle/)
  assert.match(source, /schedules\.frequencyInterval/)
  assert.match(source, /schedules\.frequencyOnce/)
  assert.doesNotMatch(source, /<Field label=\{t\('schedules\.name'\)\}>/)
  assert.match(source, /name: title\.trim\(\)/)
})

test('uses the program timezone without exposing a timezone field', () => {
  assert.match(source, /Intl\.DateTimeFormat\(\)\.resolvedOptions\(\)\.timeZone/)
  assert.doesNotMatch(source, /<Field label=\{t\('schedules\.timezone'\)\}>/)
})
