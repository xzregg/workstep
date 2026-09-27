import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const layoutSource = readFileSync(new URL('../src/components/Layout.tsx', import.meta.url), 'utf8')
const layoutCss = readFileSync(new URL('../src/components/Layout.css', import.meta.url), 'utf8')

test('sidebar restores all expanded projects and their nested sections', () => {
  assert.match(layoutSource, /expandedProjectIds,/)
  assert.match(layoutSource, /useState<string\[\]>\(\s*storedSidebarSections.expandedProjectIds,/)
  assert.match(layoutSource, /storedSidebarSections\.expandedProjectIds\.includes\(project\.id\)/)
  assert.match(layoutSource, /flowsByProject: flowSectionOpen/)
  assert.match(layoutSource, /conversationsByProject: sessionSectionOpen/)
})

test('workflow rows only show selected state outside chat context', () => {
  assert.match(layoutSource, /const workflowSelected = location\.pathname !== '\/chat'[\s\S]*activeWorkflowId === wf\.id/)
  assert.match(layoutSource, /data-active=\{workflowSelected\}/)
  assert.match(layoutCss, /\.layout-workflow-row\[data-active="true"\][^{]*\{[^}]*color: var\(--accent\); background: var\(--accent-light\)/)
})
