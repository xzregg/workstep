import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const layoutSource = readFileSync(new URL('../src/components/Layout.tsx', import.meta.url), 'utf8')

test('sidebar restores the last expanded project and its nested sections', () => {
  assert.match(layoutSource, /expandedProjectId: activeProject\?\.id/)
  assert.match(layoutSource, /project\.id === storedSidebarSections\.expandedProjectId/)
  assert.match(layoutSource, /flowsByProject: flowSectionOpen/)
  assert.match(layoutSource, /conversationsByProject: sessionSectionOpen/)
})
