import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const taskCardSource = await readFile(new URL('../src/components/TaskBoardCard.tsx', import.meta.url), 'utf8')
const tableSource = await readFile(new URL('../src/components/TaskTableView.tsx', import.meta.url), 'utf8')
const css = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')

test('keeps task card metadata and fixed action buttons on one line', () => {
  assert.match(taskCardSource, /className="task-card-meta"/)
  assert.match(taskCardSource, /text=\{cardMetaText\}/)
  assert.match(taskCardSource, /forceActive/)
  assert.match(taskCardSource, /className="card-action-buttons task-board-card-buttons"/)
  assert.match(css, /\.task-board-card-buttons\s*\{[^}]*flex-wrap:\s*nowrap/s)
  assert.match(css, /\.task-board-card-buttons\s*\{[^}]*flex-shrink:\s*0/s)
})

test('task card metadata shows the creator name without a creator prefix', () => {
  assert.match(taskCardSource, /task\.creator_name \? task\.creator_name : ''/)
  assert.doesNotMatch(taskCardSource, /task\.creator_name \? `\$\{t\('taskList\.creator'\)\}：\$\{task\.creator_name\}`/)
})

test('table view supports selecting individual and all actionable tasks', () => {
  assert.match(tableSource, /type="checkbox"/)
  assert.match(tableSource, /aria-label=\{t\('taskList\.selectAllTasks'\)\}/)
  assert.match(tableSource, /toggleTask\(task\.id\)/)
  assert.match(tableSource, /toggleAll\(\)/)
})

test('table selection offers confirmed bulk archive and delete actions', () => {
  assert.match(tableSource, /t\('taskList\.bulkArchive'\)/)
  assert.match(tableSource, /t\('taskList\.bulkDelete'\)/)
  assert.match(tableSource, /await Promise\.all\(selectedIds\.map\(onArchiveTask\)\)/)
  assert.match(tableSource, /await Promise\.all\(selectedIds\.map\(onDeleteTask\)\)/)
  assert.match(tableSource, /<ConfirmDialog/)
})

test('running tasks cannot be selected for destructive bulk actions', () => {
  assert.match(tableSource, /task\.status !== 'running'/)
  assert.match(tableSource, /disabled=\{!isActionable\}/)
})
