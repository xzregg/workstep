import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { installDomEnvironment } from './helpers/domEnv'
import { engineApi, type Project } from '../src/api/client'
import { I18nProvider } from '../src/i18n'
import { useProjectStore } from '../src/stores/projectStore'
import EngineCapabilitiesDialog from '../src/components/EngineCapabilitiesDialog'

test('capabilities dialog inspects the active project and closes', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const originalInspect = engineApi.inspect
  const originalProject = useProjectStore.getState().activeProject
  const project: Project = { id: 'project-one', name: 'Project', path: '/tmp/project-one', steps: {}, workflows: [] }
  useProjectStore.setState({ activeProject: project })
  let requested: [string, string | undefined, string | undefined] | undefined
  let closed = false
  engineApi.inspect = async (engineId, projectId, projectRoot) => {
    requested = [engineId, projectId, projectRoot]
    return {
      engine_id: engineId, project_root: projectRoot || null,
      skills: [{ name: 'Example Skill', description: 'Skill details', source_dir: '/tmp/skills' }],
      input_items: [], mcp_servers: [], mcp_supported: true, mcp_error: null,
    }
  }
  try {
    await act(async () => root.render(
      <I18nProvider><EngineCapabilitiesDialog engineId="pydantic_ai" onClose={() => { closed = true }} /></I18nProvider>,
    ))
    assert.deepEqual(requested, ['pydantic_ai', project.id, project.path])
    assert.match(container.textContent || '', /Example Skill/)
    const closeButton = container.querySelector<HTMLButtonElement>('.modal-header button')
    assert.ok(closeButton)
    await act(async () => closeButton.click())
    assert.equal(closed, true)
  } finally {
    engineApi.inspect = originalInspect
    useProjectStore.setState({ activeProject: originalProject })
    await act(async () => root.unmount())
    container.remove()
    await window.happyDOM.close()
  }
})
