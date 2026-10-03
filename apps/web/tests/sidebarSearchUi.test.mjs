import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/components/Layout.tsx', import.meta.url), 'utf8')

test('project heading exposes a button that expands sidebar search', () => {
  const projectsIndex = source.indexOf("{t('layout.projects')}")
  const searchButtonIndex = source.indexOf("aria-label={t('layout.searchSidebar')}")
  const searchInputIndex = source.indexOf('type="search"', searchButtonIndex)

  assert.notEqual(projectsIndex, -1)
  assert.notEqual(searchButtonIndex, -1)
  assert.notEqual(searchInputIndex, -1)
  assert.ok(projectsIndex < searchButtonIndex)
  assert.ok(searchButtonIndex < searchInputIndex)
  assert.match(source, /<Icon name="search"/)
})

test('sidebar search filters project workflows and conversations', () => {
  assert.match(source, /filterSidebarProject/)
  assert.match(source, /searchResult\.workflows\.map/)
  assert.match(source, /<SidebarConversationTabs sessions=\{searchResult\.sessions\}/)
})
