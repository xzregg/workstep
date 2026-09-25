import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { taskApi, fsApi } from '../src/api/client'
import { I18nProvider } from '../src/i18n'
import { useTaskArtifacts } from '../src/hooks/useTaskArtifacts'

test('task artifacts load their directory and input snapshots, then preview a selected file', async () => {
  const { window } = installDomEnvironment()
  const original = taskApi.artifacts
  const originalOpen = fsApi.openDirectory
  const requests: string[] = []
  const opened: string[] = []
  taskApi.artifacts = async (taskId, projectId) => {
    requests.push(`${taskId}:${projectId}`)
    return { artifacts: [{ name: 'report.md', step_key: 'build', round: 1,
      path: '/artifacts/report.md', is_dir: true }], input_snapshots: [{ id: 'input-1' }],
      artifact_directory: '/artifacts' } as Awaited<ReturnType<typeof taskApi.artifacts>>
  }
  fsApi.openDirectory = async (path) => {
    opened.push(path)
    return { path } as Awaited<ReturnType<typeof fsApi.openDirectory>>
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const steps = [{ step_key: 'build', status: 'passed' }]
  let artifacts!: ReturnType<typeof useTaskArtifacts>
  function Harness({ remote = false }: { remote?: boolean }) {
    artifacts = useTaskArtifacts({ taskId: 'task-1', projectId: 'project-1', steps, remote })
    return <div>{artifacts.artifactDirectory}</div>
  }
  try {
    await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
    assert.deepEqual(requests, ['task-1:project-1'])
    assert.equal(artifacts.artifactDirectory, '/artifacts')
    assert.equal(artifacts.inputSnapshots.length, 1)
    await act(async () => artifacts.openArtifact('report.md', 'build'))
    assert.equal(artifacts.previewArtifact?.path, '/artifacts/report.md')
    await act(async () => { await artifacts.openArtifactDirectory() })
    assert.deepEqual(opened, ['/artifacts/report.md'])
    await act(async () => root.render(<I18nProvider><Harness remote /></I18nProvider>))
    await act(async () => { await artifacts.openArtifactDirectory() })
    assert.deepEqual(opened, ['/artifacts/report.md'])
  } finally {
    await act(async () => root.unmount())
    taskApi.artifacts = original
    fsApi.openDirectory = originalOpen
    container.remove()
    await window.happyDOM.close()
  }
})

test('opening a newly generated artifact refreshes once before reporting it missing', async () => {
  const { window } = installDomEnvironment()
  const original = taskApi.artifacts
  let calls = 0
  taskApi.artifacts = async () => {
    calls++
    return { artifacts: calls === 1 ? [] : [{ name: 'new.md', step_key: 'build', round: 1,
      path: '/artifacts/new.md' }], input_snapshots: [], artifact_directory: ''
    } as Awaited<ReturnType<typeof taskApi.artifacts>>
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const steps = [{ step_key: 'build', status: 'running' }]
  let artifacts!: ReturnType<typeof useTaskArtifacts>
  function Harness() {
    artifacts = useTaskArtifacts({ taskId: 'task-1', projectId: 'project-1', steps, remote: false })
    return <div>{artifacts.notice}</div>
  }
  try {
    await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>))
    await act(async () => { await artifacts.openArtifact('new.md', 'build') })
    assert.equal(calls, 2)
    assert.equal(artifacts.previewArtifact?.path, '/artifacts/new.md')
    assert.equal(artifacts.notice, '')
  } finally {
    await act(async () => root.unmount())
    taskApi.artifacts = original
    container.remove()
    await window.happyDOM.close()
  }
})
