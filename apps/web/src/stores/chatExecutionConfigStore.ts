import { create } from 'zustand'
import type { ChatSessionExecutionConfig } from '../api/client'
import type { AGUIEvent } from '../utils/agui'

export const chatExecutionConfigKey = (projectId: string, sessionId: string) => JSON.stringify([projectId, sessionId])

interface State {
  configs: Record<string, ChatSessionExecutionConfig>
  receive: (projectId: string, config: ChatSessionExecutionConfig) => ChatSessionExecutionConfig
  handleWsEvent: (event: AGUIEvent) => void
}

/** Shared execution config is distinct from historical message execution metadata. */
export const useChatExecutionConfigStore = create<State>((set, get) => ({
  configs: {},
  receive: (projectId, config) => {
    const key = chatExecutionConfigKey(projectId, config.id)
    const current = get().configs[key]
    if (current && (config.execution_config_revision ?? 0) < (current.execution_config_revision ?? 0)) return current
    // Never retain message history or native engine state in this small config cache.
    const next: ChatSessionExecutionConfig = {
      id: config.id, project_id: projectId, engine: config.engine, provider_id: config.provider_id,
      model: config.model, fast_model: config.fast_model, vision_model: config.vision_model,
      thinking_effort: config.thinking_effort, service_tier: config.service_tier,
      permission_mode: config.permission_mode !== undefined ? config.permission_mode
        : current?.engine === config.engine ? current.permission_mode : undefined,
      execution_config_revision: config.execution_config_revision ?? 0, pending_handoff: config.pending_handoff ?? null,
    }
    set(state => ({ configs: { ...state.configs, [key]: next } }))
    return next
  },
  handleWsEvent: event => {
    if (event.type !== 'CUSTOM' || event.name !== 'workstep.chat_execution_config'
      || !['session_chat', 'channel_chat'].includes(event.channel || '')) return
    const value = event.value
    const projectId = event.project_id
    if (typeof projectId !== 'string' || typeof event.session_id !== 'string'
      || !value || value.id !== event.session_id || value.project_id !== projectId
      || typeof value.engine !== 'string' || !Number.isSafeInteger(value.execution_config_revision)
      || Number(value.execution_config_revision) < 0) return
    get().receive(projectId, value as unknown as ChatSessionExecutionConfig)
  },
}))
