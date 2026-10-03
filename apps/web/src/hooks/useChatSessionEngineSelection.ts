import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AssistantConfigInfo, ChatSessionDetail, CoordinatorEngineSummary, ProviderInfo,
} from '../api/client'
import {
  clearIncompatibleProvider, EMPTY_ENGINE_CONFIG, hasChatEngineConfig,
  loadChatEngineConfig, saveChatEngineConfig, type ChatEngineConfigState,
} from '../utils/chatEngineConfig'

interface Options {
  projectId: string
  sessionId: string | null
  savedSessionId: string | null
  engines: CoordinatorEngineSummary[]
  providers: ProviderInfo[]
}

/** Owns a chat session's selected engine, dependent models and local persistence. */
export function useChatSessionEngineSelection({
  projectId, sessionId, savedSessionId, engines, providers,
}: Options) {
  const [config, setConfig] = useState<ChatEngineConfigState>({ ...EMPTY_ENGINE_CONFIG })
  const configRef = useRef(config)
  configRef.current = config

  useEffect(() => {
    if (!sessionId || !projectId) return
    return () => { saveChatEngineConfig(projectId, sessionId, configRef.current) }
  }, [sessionId, projectId])

  const setDefaults = useCallback((defaults: AssistantConfigInfo['configured']) => {
    setConfig({
      engine: defaults.engine || '',
      providerId: defaults.provider_id || '',
      model: defaults.model || '',
      fastModel: defaults.fast_model || '',
      visionModel: defaults.vision_model || '',
      thinkingEffort: defaults.thinking_effort || '',
      providerCleared: false,
    })
  }, [])

  const restoreSession = useCallback((detail: ChatSessionDetail) => {
    const saved = loadChatEngineConfig(projectId, detail.id)
    // 已持久化会话的引擎决定恢复与交接目标，旧缓存不能覆盖它。
    const staleEngine = Boolean(detail.engine && saved.engine !== detail.engine)
    const restored = hasChatEngineConfig(saved) && !staleEngine
      ? clearIncompatibleProvider(saved, engines, providers)
      : {
          engine: detail.engine || '',
          providerId: detail.provider_id || '',
          model: detail.model || '',
          fastModel: detail.fast_model || '',
          visionModel: detail.vision_model || '',
          thinkingEffort: '',
        }
    let next = restored
    // 本地配置缺供应商但会话行有（状态不同步 / 换设备 / 兼容清理后）：
    // 以会话行为准回填；若与当前引擎协议不兼容则仍按「跟随默认」清空。
    if (!next.providerId && !next.providerCleared && detail.provider_id) {
      const compatible = clearIncompatibleProvider(
        { ...next, providerId: detail.provider_id },
        engines,
        providers,
      )
      next = { ...next, providerId: compatible.providerId }
    }
    if (staleEngine || next.providerId !== saved.providerId) {
      saveChatEngineConfig(projectId, detail.id, next)
    }
    setConfig(next)
  }, [projectId, engines, providers])

  useEffect(() => {
    if (!savedSessionId || !projectId || !config.providerId) return
    const saved = loadChatEngineConfig(projectId, savedSessionId)
    if (saved.engine !== config.engine || saved.providerId !== config.providerId) return
    const compatible = clearIncompatibleProvider(saved, engines, providers)
    if (compatible.providerId === saved.providerId) return
    setConfig((current) => ({ ...current, providerId: compatible.providerId }))
    saveChatEngineConfig(projectId, savedSessionId, compatible)
  }, [savedSessionId, projectId, config.engine, config.providerId, engines, providers])

  const applyHandoff = useCallback((detail: ChatSessionDetail) => {
    setConfig({
      engine: detail.engine || '',
      providerId: detail.provider_id || '',
      model: detail.model || '',
      fastModel: detail.fast_model || '',
      visionModel: detail.vision_model || '',
      thinkingEffort: '',
    })
  }, [])

  const chooseEngine = useCallback((engine: string) => {
    setConfig({ ...EMPTY_ENGINE_CONFIG, engine })
  }, [])
  const chooseProvider = useCallback((providerId: string) => {
    setConfig((current) => ({
      ...EMPTY_ENGINE_CONFIG, engine: current.engine, providerId, providerCleared: !providerId,
    }))
  }, [])
  const setModel = useCallback((model: string) => {
    setConfig((current) => ({ ...current, model }))
  }, [])
  const setFastModel = useCallback((fastModel: string) => {
    setConfig((current) => ({ ...current, fastModel }))
  }, [])
  const setVisionModel = useCallback((visionModel: string) => {
    setConfig((current) => ({ ...current, visionModel }))
  }, [])
  const setThinkingEffort = useCallback((thinkingEffort: string) => {
    setConfig((current) => ({ ...current, thinkingEffort }))
  }, [])
  const reset = useCallback(() => { setConfig({ ...EMPTY_ENGINE_CONFIG }) }, [])

  return {
    config, setDefaults, restoreSession, applyHandoff, chooseEngine, chooseProvider,
    setModel, setFastModel, setVisionModel, setThinkingEffort, reset,
  }
}
