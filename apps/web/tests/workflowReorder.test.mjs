import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/components/Layout.tsx', import.meta.url), 'utf8')
const storeSource = await readFile(new URL('../src/stores/projectStore.ts', import.meta.url), 'utf8')
const clientSource = await readFile(new URL('../src/api/project.ts', import.meta.url), 'utf8')

test('workflow rows support drag-and-drop reordering', () => {
  assert.match(source, /draggable=\{renameWfId !== wf\.id\}/)
  assert.match(source, /onDragStart=\{/)
  assert.match(source, /onDragOver=\{/)
  assert.match(source, /onDrop=\{/)
  assert.match(source, /reorderWorkflows\(p\.id, next\)/)
})

test('reorder API is wired through the client and store', () => {
  assert.match(clientSource, /reorder: \(projectId: string, orderedIds: string\[\]\)/)
  assert.match(clientSource, /ordered_ids: orderedIds/)
  assert.match(storeSource, /reorderWorkflows: async \(projectId: string, orderedIds: string\[\]\)/)
})
