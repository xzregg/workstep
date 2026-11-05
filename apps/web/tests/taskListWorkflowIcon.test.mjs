import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/pages/TaskList.tsx', import.meta.url), 'utf8')
const editorSource = await readFile(new URL('../src/components/WorkflowNameEditor.tsx', import.meta.url), 'utf8')

test('current workflow name uses the workflow icon instead of an external-link icon', () => {
  assert.match(source, /<WorkflowNameEditor[\s\S]*?canEdit=\{can\('workflow.edit'\)\}/)
  assert.match(editorSource, /<Icon name="workflow"/)
  assert.doesNotMatch(editorSource, /<Icon name="external-link"/)
})
