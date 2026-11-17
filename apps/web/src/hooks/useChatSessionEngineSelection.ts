import { useCallback, useEffect, useRef, useState } from 'react'
import { chatSessionApi, type AssistantConfigInfo, type ChatExecutionConfigPatch,
  type ChatSessionDetail, type ChatSessionExecutionConfig, type CoordinatorEngineSummary, type ProviderInfo } from '../api/client'
import { EMPTY_ENGINE_CONFIG, saveChatEngineConfig, type ChatEngineConfigState } from '../utils/chatEngineConfig'
import { chatExecutionConfigKey, useChatExecutionConfigStore } from '../stores/chatExecutionConfigStore'

interface Options {
  projectId: string
  sessionId: string | null
  savedSessionId: string | null
  engines: CoordinatorEngineSummary[]
  providers: ProviderInfo[]
}

/** All viewers follow the same versioned execution config; local cache is never authoritative. */
export function useChatSessionEngineSelection({ projectId, sessionId }: Options) {
  const [config, setConfig] = useState<ChatEngineConfigState>({ ...EMPTY_ENGINE_CONFIG })
  const [permissionMode, setPermissionMode] = useState('')
  const [pendingHandoff, setPendingHandoff] = useState<ChatSessionDetail['pending_handoff']>(null)
  const [loadedEndpoint, setLoadedEndpoint] = useState<{ engine: string; providerId: string } | null>(null)
  const [pendingWrites, setPendingWrites] = useState(0)
  const [error, setError] = useState('')
  const scopeKey = chatExecutionConfigKey(projectId, sessionId || '')
  const scope = useRef({ key: scopeKey })
  if (scope.current.key !== scopeKey) scope.current = { key: scopeKey }
  const shared = useChatExecutionConfigStore(state => state.configs[scopeKey])

  const applySnapshot = useCallback((snapshot: ChatSessionExecutionConfig) => {
    const next = {
      engine: snapshot.engine || '', providerId: snapshot.provider_id || '',
      model: snapshot.model || '', fastModel: snapshot.fast_model || '', visionModel: snapshot.vision_model || '',
      thinkingEffort: snapshot.thinking_effort || '', serviceTier: snapshot.service_tier || '', providerCleared: false,
    }
    setConfig(next)
    setPermissionMode(snapshot.permission_mode || '')
    setPendingHandoff(snapshot.pending_handoff ?? null)
    setLoadedEndpoint({ engine: next.engine, providerId: next.providerId })
    saveChatEngineConfig(projectId, snapshot.id, next)
  }, [projectId])

  useEffect(() => { if (shared) applySnapshot(shared) }, [shared, applySnapshot])
  useEffect(() => { setPendingWrites(0); setError('') }, [scopeKey])

  const applyAuthoritative = useCallback((snapshot: ChatSessionExecutionConfig) => {
    applySnapshot(useChatExecutionConfigStore.getState().receive(projectId, snapshot))
  }, [projectId, applySnapshot])

  const saveOptions = useCallback((changes: ChatExecutionConfigPatch) => {
    if (!projectId || !sessionId) return
    const requestScope = scope.current
    setPendingWrites(value => value + 1)
    setError('')
    void chatSessionApi.updateExecutionConfig(sessionId, projectId, changes).then(snapshot => {
      // Cache the committed result even after navigation, but never apply it to another viewer scope.
      const latest = useChatExecutionConfigStore.getState().receive(projectId, snapshot)
      if (scope.current === requestScope) applySnapshot(latest)
    }).catch(reason => {
      if (scope.current !== requestScope) return
      const latest = useChatExecutionConfigStore.getState().configs[requestScope.key]
      if (latest) applySnapshot(latest)
      setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => {
      if (scope.current === requestScope) setPendingWrites(value => Math.max(0, value - 1))
    })
  }, [projectId, sessionId, applySnapshot])

  const setDefaults = useCallback((defaults: AssistantConfigInfo['configured']) => {
    setConfig({ engine: defaults.engine || '', providerId: defaults.provider_id || '',
      model: defaults.model || '', fastModel: defaults.fast_model || '', visionModel: defaults.vision_model || '',
      thinkingEffort: defaults.thinking_effort || '', serviceTier: '', providerCleared: false })
  }, [])

  // These local fallbacks are for an empty/new composer. Existing endpoints are saved by transitions.
  const chooseEngine = useCallback((engine: string) => {
    setConfig({ ...EMPTY_ENGINE_CONFIG, engine })
    setPermissionMode('')
  }, [])
  const chooseProvider = useCallback((providerId: string) => {
    setConfig(current => ({ ...EMPTY_ENGINE_CONFIG, engine: current.engine, providerId, providerCleared: !providerId }))
  }, [])
  const setModel = useCallback((model: string) => {
    setConfig(current => ({ ...current, model })); saveOptions({ model })
  }, [saveOptions])
  const setFastModel = useCallback((fast_model: string) => {
    setConfig(current => ({ ...current, fastModel: fast_model })); saveOptions({ fast_model })
  }, [saveOptions])
  const setVisionModel = useCallback((vision_model: string) => {
    setConfig(current => ({ ...current, visionModel: vision_model })); saveOptions({ vision_model })
  }, [saveOptions])
  const setThinkingEffort = useCallback((thinking_effort: string) => {
    setConfig(current => ({ ...current, thinkingEffort: thinking_effort })); saveOptions({ thinking_effort })
  }, [saveOptions])
  const setServiceTier = useCallback((service_tier: string) => {
    setConfig(current => ({ ...current, serviceTier: service_tier })); saveOptions({ service_tier })
  }, [saveOptions])
  const reset = useCallback(() => {
    saveOptions({ model: '', fast_model: '', vision_model: '', thinking_effort: '', service_tier: '' })
  }, [saveOptions])

  return { config, permissionMode, setPermissionMode, pendingHandoff, loadedEndpoint, saving: pendingWrites > 0, error,
    setDefaults, restoreSession: applyAuthoritative, applyHandoff: applyAuthoritative, chooseEngine, chooseProvider,
    setModel, setFastModel, setVisionModel, setThinkingEffort, setServiceTier, reset }
}
