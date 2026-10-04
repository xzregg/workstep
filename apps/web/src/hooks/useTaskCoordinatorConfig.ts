import { useEffect, useRef, useState } from 'react'
import { providerApi, taskApi, type CoordinatorConfig, type ProviderInfo } from '../api/client'
import { useI18n, type TKey } from '../i18n'
import { publishEngineCatalog } from '../stores/engineAvailabilityStore'

type ConfigField = 'engine' | 'provider' | 'model' | 'fastModel' | 'visionModel' | 'thinkingEffort'

const ERROR_KEYS: Record<ConfigField, TKey> = {
  engine: 'taskDetail.engineSwitchFailed',
  provider: 'taskDetail.engineSwitchFailed',
  model: 'taskDetail.modelSwitchFailed',
  fastModel: 'taskDetail.fastModelSwitchFailed',
  visionModel: 'taskDetail.visionModelSwitchFailed',
  thinkingEffort: 'taskDetail.effortSwitchFailed',
}

/** Owns loading and updating the coordinator engine selection for one task. */
export function useTaskCoordinatorConfig(taskId: string, projectId: string) {
  const { t } = useI18n()
  const [config, setConfig] = useState<CoordinatorConfig | null>(null)
  const [providers, setProviders] = useState<ProviderInfo[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const saveInFlight = useRef(false)

  useEffect(() => {
    let active = true
    if (!taskId || !projectId) {
      setConfig(null)
      return () => { active = false }
    }
    void taskApi.coordinatorConfig(taskId, projectId).then((loaded) => {
      if (!active) return
      setConfig(loaded)
      publishEngineCatalog(loaded.available_engines)
      setError('')
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : t('taskDetail.coordinatorEngineLoadFailed'))
    })
    return () => { active = false }
  }, [taskId, projectId, t])

  useEffect(() => {
    let active = true
    if (!projectId) {
      setProviders([])
      return () => { active = false }
    }
    void providerApi.list(projectId).then((result) => {
      if (active) setProviders(result.providers.filter((provider) => provider.enabled))
    }).catch(() => { /* provider list is optional for the engine picker */ })
    return () => { active = false }
  }, [projectId])

  const save = async (field: ConfigField, value: string) => {
    if (!taskId || !projectId || saveInFlight.current || (field !== 'engine' && !config)) return
    saveInFlight.current = true
    setSaving(true)
    setError('')
    setNotice('')
    const configured = config?.configured
    const engine = field === 'engine' ? value || null
      : configured?.engine || config?.resolved.engine || null
    const provider = field === 'engine'
      ? value === 'pydantic_ai' ? configured?.provider_id || null : null
      : field === 'provider' ? value || null : configured?.provider_id || null
    const clearModels = field === 'engine' || field === 'provider'
    try {
      const selection = await taskApi.updateCoordinatorConfig(
        taskId, projectId, engine,
        clearModels ? null : field === 'model' ? value || null : configured?.model ?? null,
        clearModels ? null : field === 'fastModel' ? value || null : configured?.fast_model ?? null,
        clearModels ? null : field === 'visionModel' ? value || null : configured?.vision_model ?? null,
        field === 'thinkingEffort' ? value || null : configured?.thinking_effort || null,
        provider,
      )
      setConfig((current) => current ? { ...current, ...selection } : current)
      setNotice(t('taskDetail.coordinatorSaved'))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t(ERROR_KEYS[field]))
    } finally {
      saveInFlight.current = false
      setSaving(false)
    }
  }

  return {
    config, providers, saving, error, notice,
    onEngineChange: (value: string) => save('engine', value),
    onProviderChange: (value: string) => save('provider', value),
    onModelChange: (value: string) => save('model', value),
    onFastModelChange: (value: string) => save('fastModel', value),
    onVisionModelChange: (value: string) => save('visionModel', value),
    onThinkingEffortChange: (value: string) => save('thinkingEffort', value),
  }
}
