import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { engineApi, fetchEngineModels } from '../api/client'
import { useI18n } from '../i18n'
import { useOnboardingStore } from '../stores/onboardingStore'
import { useProjectStore } from '../stores/projectStore'
import { buildStarterWorkflow } from '../utils/onboarding'
import type { SettingsFocusTarget, SettingsSection } from '../pages/SettingsPage'
import OnboardingChecklist from './OnboardingChecklist'

interface Props {
  onOpenSettings: (section: SettingsSection, focus: SettingsFocusTarget) => void
  onOpenProject: () => void
}

export default function LayoutOnboardingActions({ onOpenSettings, onOpenProject }: Props) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const { projects, activeProject, activeWorkflowId, setActiveProject, createWorkflow, fetchProjects, setActiveWorkflow } = useProjectStore()
  const [creatingWorkflow, setCreatingWorkflow] = useState(false)
  const [error, setError] = useState('')

  const openSettings = (section: SettingsSection, focus: SettingsFocusTarget) => {
    setError('')
    onOpenSettings(section, focus)
  }

  const openProject = () => {
    setError('')
    onOpenProject()
  }

  const createOnboardingWorkflow = async () => {
    const onboarding = useOnboardingStore.getState()
    const project = projects.find((item) => item.id === onboarding.projectId && item.type !== 'remote')
      ?? (activeProject?.type !== 'remote' ? activeProject : undefined)
    if (creatingWorkflow) return
    if (!project) {
      setError(t('onboarding.projectRequired'))
      return
    }
    setCreatingWorkflow(true)
    setError('')
    try {
      const execution = await engineApi.executionConfig()
      const engineId = onboarding.engineId || execution.engine
      if (!engineId) throw new Error(t('onboarding.engineRequired'))
      if (onboarding.engineId !== engineId) onboarding.recordEngine(engineId)
      let model = ''
      try {
        const result = await fetchEngineModels(engineId, false, onboarding.providerId || '', project.id)
        model = result.default_model || ''
      } catch {
        // The engine may validly use its own implicit default model.
      }
      setActiveProject(project)
      const workflow = await createWorkflow(
        project.id,
        '分析与执行',
        undefined,
        buildStarterWorkflow(engineId, model),
      )
      onboarding.recordWorkflow(workflow.id)
      await fetchProjects()
      const refreshedProject = useProjectStore.getState().projects.find((item) => item.id === project.id)
      if (refreshedProject) setActiveProject(refreshedProject)
      await setActiveWorkflow(workflow.id)
      navigate(`/canvas?project=${encodeURIComponent(project.name)}&workflow=${encodeURIComponent(workflow.id)}&onboarding=1`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('onboarding.createWorkflowFailed'))
    } finally {
      setCreatingWorkflow(false)
    }
  }

  const openOnboardingTask = () => {
    const onboarding = useOnboardingStore.getState()
    const project = projects.find((item) => item.id === onboarding.projectId) ?? activeProject
    const workflowId = onboarding.workflowId || activeWorkflowId
    if (!project || !workflowId) {
      setError(t('onboarding.workflowRequired'))
      return
    }
    setActiveProject(project)
    void setActiveWorkflow(workflowId)
    navigate(`/tasks?project=${encodeURIComponent(project.name)}&onboarding=create-task`)
  }

  return <OnboardingChecklist
    creatingWorkflow={creatingWorkflow}
    error={error}
    onOpenProvider={() => {
      useOnboardingStore.getState().chooseSetupMode('provider')
      openSettings('providers', 'provider-create')
    }}
    onOpenLocalAgent={() => {
      useOnboardingStore.getState().chooseSetupMode('local')
      openSettings('engines', 'execution-engine')
    }}
    onOpenEngine={() => openSettings('engines', 'execution-engine')}
    onOpenProject={openProject}
    onCreateWorkflow={() => void createOnboardingWorkflow()}
    onCreateTask={openOnboardingTask}
  />
}
