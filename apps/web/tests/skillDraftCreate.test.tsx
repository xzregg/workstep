import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { I18nProvider } from '../src/i18n'
import { skillApi } from '../src/api/client'
import { useProjectStore } from '../src/stores/projectStore'
import { loadDraft } from '../src/utils/chatDraft'
import SkillDraftCreateButton from '../src/components/SkillDraftCreateButton'

function Location() { const location = useLocation(); return <output>{location.pathname}{location.search}</output> }

test('skill creation opens an ordinary runtime conversation without installing or scanning skills', async () => {
  const { window } = installDomEnvironment()
  const oldCreate = skillApi.onboarding, oldState = useProjectStore.getState()
  skillApi.onboarding = async () => ({ project_id: 'runtime', project_name: 'runtime', session_id: 'draft-session', workspace_path: '/runtime', package_path: '/runtime/skills/draft', prompt: '只编写草稿，不安装技能' })
  let refreshed = 0, closed = 0
  useProjectStore.setState({ fetchProjects: async () => { refreshed++ } })
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  try {
    await act(async () => root.render(<MemoryRouter><I18nProvider><SkillDraftCreateButton onStarted={() => { closed++ }} /><Location /></I18nProvider></MemoryRouter>))
    await act(async () => document.querySelector<HTMLButtonElement>('button')!.click())
    assert.equal(document.querySelector('output')?.textContent, '/chat?project=runtime&session=draft-session')
    assert.equal(loadDraft('draft-session'), '只编写草稿，不安装技能')
    assert.equal(refreshed, 1); assert.equal(closed, 1)
  } finally { await act(async () => root.unmount()); skillApi.onboarding = oldCreate; useProjectStore.setState(oldState); await window.happyDOM.close() }
})
