import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { I18nProvider } from '../src/i18n'
import ProjectGitButton from '../src/components/git/ProjectGitButton'
import type { Project } from '../src/api/client'

function Location() { const location = useLocation(); return <output>{location.pathname + location.search}</output> }
test('project Git entry carries project context and is hidden for remote projects', async () => {
  const { window } = installDomEnvironment()
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  const project = { id: 'project a', name: 'Project', path: '/repo', workflows: [], steps: {} } as Project
  const render = (p: Project) => <I18nProvider><MemoryRouter><ProjectGitButton project={p} /><Location /></MemoryRouter></I18nProvider>
  try {
    await act(async () => root.render(render(project)))
    await act(async () => document.querySelector<HTMLButtonElement>('button')!.click())
    assert.equal(document.querySelector('output')?.textContent, '/git?project_id=project%20a')
    await act(async () => root.render(render({ ...project, type: 'remote' })))
    assert.equal(document.querySelector('button'), null)
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})
