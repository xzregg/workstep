import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/pages/SchedulePage.tsx', import.meta.url), 'utf8')
const taskListSource = await readFile(new URL('../src/pages/TaskList.tsx', import.meta.url), 'utf8')
const mobileCss = await readFile(new URL('../src/mobile.css', import.meta.url), 'utf8')

test('uses nearly the full desktop viewport height for the schedule dialog', () => {
  assert.match(taskListSource, /className="modal-overlay schedule-dialog-overlay"[\s\S]*?padding:\s*12/)
  assert.match(taskListSource, /className="modal schedule-dialog"[\s\S]*?height:\s*'min\(1080px, calc\(100dvh - 24px\)\)'/)
  assert.match(taskListSource, /maxHeight:\s*'calc\(100dvh - 24px\)'/)
})

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

test('renders each schedule as a two-row item with title/status then time/summary', () => {
  assert.match(source, /import MarqueeText from '\.\.\/components\/MarqueeText'/)
  assert.match(source, /className="schedule-list-item"/)
  assert.match(source, /className="schedule-list-item"[\s\S]*?display:\s*'block'/)
  assert.match(source, /className="schedule-list-title-row"/)
  assert.match(source, /<MarqueeText[\s\S]*?text=\{item\.task_template\.title/)
  assert.match(source, /className="schedule-list-status"/)
  assert.match(source, /className="schedule-list-meta"/)
  assert.match(source, /className="schedule-list-time"/)
  assert.match(source, /className="schedule-list-summary"/)
  assert.ok(source.indexOf('className="schedule-list-status"') < source.indexOf('className="schedule-list-meta"'))
  assert.ok(source.indexOf('className="schedule-list-time"') < source.indexOf('className="schedule-list-summary"'))
})

test('uses a single-column list and editor flow on mobile', () => {
  assert.match(source, /className=\{`schedule-page\$\{selected \|\| creating \? ' schedule-page--editing' : ''\}/)
  assert.match(source, /className="schedule-layout"/)
  assert.match(source, /className="schedule-list"/)
  assert.match(source, /className="schedule-editor"/)
  assert.match(source, /className="schedule-runs"/)
  assert.match(source, /className="schedule-mobile-back"/)
  assert.match(source, /className="schedule-form-grid"/)
  assert.match(mobileCss, /\.schedule-dialog-overlay\s*\{[^}]*padding:\s*0 !important/s)
  assert.match(mobileCss, /\.schedule-dialog\s*\{[^}]*width:\s*100% !important[^}]*height:\s*100% !important/s)
  assert.match(mobileCss, /\.schedule-layout\s*\{[^}]*display:\s*block !important[^}]*overflow-y:\s*auto/s)
  assert.match(mobileCss, /\.schedule-page:not\(\.schedule-page--editing\) \.schedule-editor[\s\S]*?display:\s*none !important/)
  assert.match(mobileCss, /\.schedule-page--editing \.schedule-list\s*\{[^}]*display:\s*none/s)
  assert.match(mobileCss, /\.schedule-page--creating:not\(\.schedule-page--testing\) \.schedule-runs\s*\{[^}]*display:\s*none !important/s)
  assert.match(mobileCss, /\.schedule-page--testing \.schedule-editor\s*\{[^}]*display:\s*none !important/s)
  assert.match(mobileCss, /\.schedule-page--testing \.schedule-runs\s*\{[^}]*display:\s*flex !important[^}]*height:\s*100%/s)
  assert.match(mobileCss, /\.schedule-form-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) !important/s)
  assert.match(mobileCss, /\.schedule-split-handle\s*\{[^}]*display:\s*none !important/s)
})
