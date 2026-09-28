import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { fsApi, type Project } from '../src/api/client'
import OpenLocationButton from '../src/components/OpenLocationButton'
import { I18nProvider, zhCNT } from '../src/i18n'
import { installDomEnvironment } from './helpers/domEnv'

test('directory button opens the supplied worktree path in the selected local app', async () => {
  const { window } = installDomEnvironment()
  const originalOpen = fsApi.openDirectory
  const originalOpeners = fsApi.directoryOpeners
  const calls: [string, string | undefined][] = []
  fsApi.directoryOpeners = async () => ({ openers: [{ id: 'file_manager', label: 'file_manager', available: true }] })
  fsApi.openDirectory = async (path, opener) => { calls.push([path, opener]); return { path } }
  const project = { id: 'p', name: 'Project', path: '/project', steps: [], workflows: [] } as Project
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><OpenLocationButton activeProject={project} directoryPath="/project/.workstep/worktrees/t" t={zhCNT} /></I18nProvider>))
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
    assert.deepEqual(calls, [['/project/.workstep/worktrees/t', 'file_manager']])
  } finally {
    await act(async () => root.unmount())
    fsApi.openDirectory = originalOpen
    fsApi.directoryOpeners = originalOpeners
    container.remove()
    await window.happyDOM.close()
  }
})

test('remote directory button previews the supplied path with its browser scope', async () => {
  const { window } = installDomEnvironment()
  const originalBrowse = fsApi.browse
  const calls: [string | undefined, string | undefined][] = []
  fsApi.browse = async (path, projectId) => {
    calls.push([path, projectId])
    return { path: path || '', entries: [], parent: null } as Awaited<ReturnType<typeof fsApi.browse>>
  }
  const project = { id: 'p', name: 'Project', path: '/project', type: 'remote', steps: [], workflows: [] } as Project
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<I18nProvider><OpenLocationButton activeProject={project} directoryPath="/external/tree" browserProjectId="" t={zhCNT} /></I18nProvider>))
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click())
    assert.deepEqual(calls, [['/external/tree', '']])
  } finally {
    await act(async () => root.unmount())
    fsApi.browse = originalBrowse
    container.remove()
    await window.happyDOM.close()
  }
})
