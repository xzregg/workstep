/**
 * Per-session chat engine-configuration persistence via localStorage.
 *
 * Records the engine / provider / model / fast-model / vision-model /
 * thinking-effort the user picked inside a given chat session, so re-entering
 * that session restores the last selection instead of falling back to defaults.
 *
 * Uses the same lazy-persist, per-(project, session) localStorage pattern as the
 * input draft (see chatDraft.ts): the page saves on session switch / unmount and
 * restores when a session loads.
 *
 * Key format: `workstep-chat-engine-config:<projectId>:<sessionId>`
 */

export interface ChatEngineConfigState {
  engine: string
  providerId: string
  model: string
  fastModel: string
  visionModel: string
  thinkingEffort: string
}

const PREFIX = 'workstep-chat-engine-config'

interface EngineProviderCompatibility {
  id: string
  provider_protocols?: string[]
  supports_provider?: boolean
}

interface ProviderCompatibility {
  id: string
  protocol?: string
  protocols?: string[]
  enabled?: boolean
}

export const EMPTY_ENGINE_CONFIG: ChatEngineConfigState = {
  engine: '',
  providerId: '',
  model: '',
  fastModel: '',
  visionModel: '',
  thinkingEffort: '',
}

function key(projectId: string, sessionId: string): string {
  return `${PREFIX}:${projectId}:${sessionId}`
}

/** Whether the config carries any explicit user selection (vs all-empty defaults). */
export function hasChatEngineConfig(config: ChatEngineConfigState): boolean {
  return Boolean(
    config.engine || config.providerId || config.model
    || config.fastModel || config.visionModel || config.thinkingEffort,
  )
}

export function saveChatEngineConfig(
  projectId: string,
  sessionId: string,
  config: ChatEngineConfigState,
): void {
  if (!projectId || !sessionId) return
  try {
    const k = key(projectId, sessionId)
    if (hasChatEngineConfig(config)) {
      localStorage.setItem(k, JSON.stringify(config))
    } else {
      localStorage.removeItem(k)
    }
  } catch {
    /* storage full or unavailable — silently ignore */
  }
}

/**
 * Always returns a fully-populated state (fields default to '') so callers can
 * read fields directly. An all-empty result means no selection was recorded.
 */
export function loadChatEngineConfig(projectId: string, sessionId: string): ChatEngineConfigState {
  if (!projectId || !sessionId) return { ...EMPTY_ENGINE_CONFIG }
  try {
    const raw = localStorage.getItem(key(projectId, sessionId))
    if (!raw) return { ...EMPTY_ENGINE_CONFIG }
    const parsed = JSON.parse(raw) as Partial<ChatEngineConfigState>
    return {
      engine: parsed_string(parsed.engine),
      providerId: parsed_string(parsed.providerId),
      model: parsed_string(parsed.model),
      fastModel: parsed_string(parsed.fastModel),
      visionModel: parsed_string(parsed.visionModel),
      thinkingEffort: parsed_string(parsed.thinkingEffort),
    }
  } catch {
    return { ...EMPTY_ENGINE_CONFIG }
  }
}

function parsed_string(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function clearChatEngineConfig(projectId: string, sessionId: string): void {
  if (!projectId || !sessionId) return
  try {
    localStorage.removeItem(key(projectId, sessionId))
  } catch {
    /* ignore */
  }
}

export function clearIncompatibleProvider(
  config: ChatEngineConfigState,
  engines: readonly EngineProviderCompatibility[],
  providers: readonly ProviderCompatibility[],
): ChatEngineConfigState {
  if (!config.engine || !config.providerId) return config
  const engine = engines.find((item) => item.id === config.engine)
  const provider = providers.find((item) => item.id === config.providerId)
  if (!engine || !provider || !provider.protocol) return config
  const compatible = Boolean(
    engine.supports_provider
    && (engine.provider_protocols || []).includes(provider.protocol),
  )
  return compatible ? config : { ...config, providerId: '' }
}
