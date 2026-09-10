import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const layoutSource = await readFile(
  new URL('../src/components/Layout.tsx', import.meta.url),
  'utf8',
)

test('Layout delegates workflow creation behind a focused module interface', () => {
  assert.match(layoutSource, /import WorkflowCreateDialog from '\.\/WorkflowCreateDialog'/)
  assert.match(layoutSource, /<WorkflowCreateDialog/)
  assert.doesNotMatch(layoutSource, /import FlowCanvas/)
  assert.doesNotMatch(layoutSource, /import AiFlowChat/)
  assert.doesNotMatch(layoutSource, /fetchTemplates/)
})

test('Layout delegates project connection behind a focused module interface', () => {
  assert.match(layoutSource, /import ProjectConnectionDialog from '\.\/ProjectConnectionDialog'/)
  assert.match(layoutSource, /<ProjectConnectionDialog/)
  assert.doesNotMatch(layoutSource, /import DirectoryBrowser/)
  assert.doesNotMatch(layoutSource, /remoteShareString/)
})

test('Layout delegates sidebar activity synchronization to its owning hook', () => {
  assert.match(layoutSource, /import \{ useSidebarActivity \} from '\.\.\/hooks\/useSidebarActivity'/)
  assert.match(layoutSource, /useSidebarActivity\(activeSessionId\)/)
  assert.doesNotMatch(layoutSource, /deriveWorkflowRunningState/)
  assert.doesNotMatch(layoutSource, /sessionProjectMap/)
})
