import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../src/components/Layout.tsx', import.meta.url), 'utf8')

test('add project action appears directly below statistics and before the project list', () => {
  const statisticsIndex = source.indexOf("{t('nav.statistics')}")
  const addProjectIndex = source.indexOf("{t('nav.addProject')}")
  const projectsIndex = source.indexOf("{t('layout.projects')}")

  assert.notEqual(statisticsIndex, -1)
  assert.notEqual(addProjectIndex, -1)
  assert.notEqual(projectsIndex, -1)
  assert.ok(statisticsIndex < addProjectIndex)
  assert.ok(addProjectIndex < projectsIndex)
})
