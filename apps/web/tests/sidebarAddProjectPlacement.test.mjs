import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/components/Layout.tsx', import.meta.url), 'utf8')

test('add project and inline search share the fixed project heading', () => {
  const addProjectIndex = source.indexOf("aria-label={t('nav.addProject')}")
  const projectsIndex = source.indexOf("{t('layout.projects')}")
  const searchIndex = source.indexOf('className="layout-sidebar-search"')
  const listIndex = source.indexOf('className="layout-sidebar-projects"')

  assert.notEqual(addProjectIndex, -1)
  assert.notEqual(projectsIndex, -1)
  assert.ok(projectsIndex < searchIndex)
  assert.ok(searchIndex < addProjectIndex)
  assert.ok(addProjectIndex < listIndex)
})
