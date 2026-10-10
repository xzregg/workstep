import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import OpenLocationButton from '../src/components/OpenLocationButton'
import { fsApi, type Project } from '../src/api/client'
import { I18nProvider, type TFunction } from '../src/i18n'
test('desktop opener detection and opening use the host bridge instead of the container API', async () => {
 const { window } = installDomEnvironment()
 const root = createRoot(document.body.appendChild(document.createElement('div')))
 const originalList = fsApi.directoryOpeners, originalOpen = fsApi.openDirectory
 const calls: unknown[] = []
 fsApi.directoryOpeners = async () => { throw new Error('container detection called') }
 fsApi.openDirectory = async () => { throw new Error('container open called') }
 Object.assign(window, { workstepDesktop: { directories: {
  openers: async () => ({ openers: [{ id: 'file_manager', label: 'Finder', available: true }, { id: 'vscode', label: 'VS Code', available: true }] }),
  open: async (path: string, opener: string) => { calls.push([path, opener]); return { opened: true, path: '/host/project' } },
 } } })
 try {
  await act(async () => root.render(<I18nProvider><OpenLocationButton activeProject={{ id: 'p', type: 'local', path: '/data/projects/demo' } as Project} t={((key: string) => key) as TFunction} /></I18nProvider>))
  await act(async () => (document.querySelector('button') as HTMLButtonElement).click())
  assert.deepEqual(calls, [['/data/projects/demo', 'file_manager']])
  await act(async () => (document.querySelectorAll('button')[1] as HTMLButtonElement).click())
  assert.match(document.body.textContent || '', /VS Code/)
 } finally {
  fsApi.directoryOpeners = originalList; fsApi.openDirectory = originalOpen
  await act(async () => root.unmount()); await window.happyDOM.close()
 }
})

test('missing desktop bridge opens a directory dialog without calling container openers', async () => {
 const { window } = installDomEnvironment()
 Object.defineProperty(window.navigator, 'userAgent', { value: 'Electron/43', configurable: true })
 const root = createRoot(document.body.appendChild(document.createElement('div')))
 const originalList = fsApi.directoryOpeners, originalOpen = fsApi.openDirectory
 let detected = 0, opened = 0, browsed = 0
 fsApi.directoryOpeners = async () => { detected++; return { openers: [] } }
 fsApi.openDirectory = async () => { opened++; return { opened: false, path: '' } }
 try {
  await act(async () => root.render(<I18nProvider><OpenLocationButton activeProject={{ id: 'p', name: 'demo', type: 'local', path: '/data/projects/demo' } as Project} t={((key: string) => key) as TFunction} browseDirectory={async () => { browsed++; return { path: '/data/projects/demo', name: 'demo', parent: null, entries: [] } }} /></I18nProvider>))
  assert.equal(document.querySelectorAll('button').length, 1)
  await act(async () => (document.querySelector('button') as HTMLButtonElement).click())
  assert.ok(document.querySelector('[role="dialog"]'))
  assert.ok(browsed > 0)
  assert.equal(detected, 0)
  assert.equal(opened, 0)
 } finally {
  fsApi.directoryOpeners = originalList; fsApi.openDirectory = originalOpen
  await act(async () => root.unmount()); await window.happyDOM.close()
 }
})
