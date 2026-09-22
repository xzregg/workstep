import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../src/pages/ChatPage.tsx', import.meta.url), 'utf8')

test('chat refresh re-resolves the URL project after the project list loads', () => {
  assert.match(source, /const \{[\s\S]*?projects,[\s\S]*?activeProject,[\s\S]*?loading: projectsLoading,/)
  assert.match(
    source,
    /\[projectParam, workflowParam, projects, projectsLoading, fetchProjects, setActiveProject, setActiveWorkflow\]/,
  )
})
