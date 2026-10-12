import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../src/pages/ChatPage.tsx', import.meta.url), 'utf8')

test('chat refresh re-resolves the URL project after the project list loads', () => {
  assert.match(source, /const \{[\s\S]*?projects,[\s\S]*?activeProject: selectedProject,[\s\S]*?loading: projectsLoading,/)
  assert.match(source, /const activeProject = embedded\?\.project \|\| selectedProject/)
  assert.match(
    source,
    /\[isEmbedded, projectParam, workflowParam, projects, projectsLoading, fetchProjects, setActiveProject, setActiveWorkflow\]/,
  )
})
