import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/pages/TaskList.tsx', import.meta.url), 'utf8')

test('current workflow name uses the workflow icon instead of an external-link icon', () => {
  const workflowNameBlock = source.slice(
    source.indexOf('{activeWorkflowName && ('),
    source.indexOf('{activeProject && (', source.indexOf('{activeWorkflowName && (')),
  )

  assert.match(workflowNameBlock, /<Icon name="workflow"/)
  assert.doesNotMatch(workflowNameBlock, /<Icon name="external-link"/)
})
