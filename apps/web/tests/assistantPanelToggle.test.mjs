import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const taskListSource = await readFile(new URL('../src/pages/TaskList.tsx', import.meta.url), 'utf8')
const taskCreateSource = await readFile(new URL('../src/components/TaskCreatePanel.tsx', import.meta.url), 'utf8')
const workflowCreateDialogSource = await readFile(new URL('../src/components/WorkflowCreateDialog.tsx', import.meta.url), 'utf8')
const scheduleSource = await readFile(new URL('../src/pages/SchedulePage.tsx', import.meta.url), 'utf8')

test('task assistant button toggles its embedded conversation', () => {
  assert.match(taskListSource, /<TaskCreatePanel/)
  assert.match(taskCreateSource, /aria-expanded=\{taskAiOpen\}/)
  assert.match(taskCreateSource, /if \(taskAiOpen\) \{\s*requestCloseTaskAi\(\)\s*return\s*\}/)
  assert.match(taskCreateSource, /className="task-create-footer"/)
  assert.match(taskCreateSource, /className="task-create-primary"/)
  assert.match(taskCreateSource, /taskAiOpen \? t\('taskList\.assistantExpanded'\) : t\('taskList\.assistantCollapsed'\)/)
  assert.doesNotMatch(
    taskCreateSource,
    /const handleStartTaskAi[\s\S]*?if \(!newTitle\.trim\(\)\)[\s\S]*?setTaskAiOpen\(true\)/,
  )
})

test('new-workflow assistant button toggles its embedded conversation', () => {
  assert.match(workflowCreateDialogSource, /aria-expanded=\{aiOpen\}/)
  assert.match(workflowCreateDialogSource, /const \[aiOpen, setAiOpen\] = useState\(true\)/)
  assert.match(workflowCreateDialogSource, /const reset[\s\S]*?setAiOpen\(true\)/)
  assert.match(workflowCreateDialogSource, /if \(aiOpen\) \{[\s\S]*?setAiOpen\(false\)[\s\S]*?return/)
  assert.doesNotMatch(
    workflowCreateDialogSource,
    /const toggleAi[\s\S]*?if \(!name\.trim\(\)\)[\s\S]*?setAiOpen\(true\)/,
  )
})

test('schedule test assistant button toggles its embedded conversation', () => {
  assert.match(scheduleSource, /aria-expanded=\{testOpen\}/)
  assert.match(scheduleSource, /onClick=\{toggleTestAssistant\}/)
  assert.match(scheduleSource, /testOpen && generation === 'agent' \? ' schedule-page--testing' : ''/)
  assert.match(scheduleSource, /if \(testOpen\) \{ closeTest\(\); return \}/)
})
