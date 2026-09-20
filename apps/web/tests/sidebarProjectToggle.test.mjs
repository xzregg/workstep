import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/components/Layout.tsx', import.meta.url), 'utf8')
const appSource = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')

test('clicking a project row toggles its nested sidebar content without collapsing other projects', () => {
  assert.match(source, /const toggleProjectExpanded = \(projectId: string\)/)
  assert.match(source, /current\.includes\(projectId\)/)
  assert.match(source, /aria-expanded=\{isProjectExpanded\(p\.id\)\}/)
  assert.match(source, /isProjectExpanded\(p\.id\) && \(/)
  assert.doesNotMatch(source, /\{activeProject\?\.id === p\.id && \(/)
  assert.match(source, /\(project\) => storedSidebarSections\.expandedProjectIds\.includes\(project\.id\)/)
})

test('selecting a project preserves the mobile navigation drawer', () => {
  assert.match(appSource, /projectSelectionPath\([\s\S]*state:\s*\{ preserveNavigationDrawer: true \}/)
})
