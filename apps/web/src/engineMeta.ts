import { zhCNT, type TFunction, type TKey } from './i18n'

export const DEFAULT_EXECUTION_ENGINE = 'pydantic_ai'

const EXECUTION_ENGINE_ORDER: Record<string, number> = {
  pydantic_ai: 0,
  claude_agent_sdk: 1,
  codex_sdk: 2,
  claude: 3,
  codex: 4,
}

export const ENGINE_LABELS: Record<string, TKey> = {
  claude: 'engine.label.claude',
  codex: 'engine.label.codex',
  hermes: 'engine.label.hermes',
  opencode: 'engine.label.opencode',
  cursor: 'engine.label.cursor',
  qoder_sdk: 'engine.label.qoder_sdk',
  openclaw: 'engine.label.openclaw',
  pydantic_ai: 'engine.label.pydantic_ai',
  claude_agent_sdk: 'engine.label.claude_agent_sdk',
  codex_sdk: 'engine.label.codex_sdk',
  deepseek_harness: 'engine.label.deepseek_harness',
}

export const ENGINE_DESCRIPTIONS: Record<string, TKey> = {
  claude: 'engine.description.claude',
  codex: 'engine.description.codex',
  hermes: 'engine.description.hermes',
  opencode: 'engine.description.opencode',
  cursor: 'engine.description.cursor',
  qoder_sdk: 'engine.description.qoder_sdk',
  openclaw: 'engine.description.openclaw',
  pydantic_ai: 'engine.description.pydantic_ai',
  claude_agent_sdk: 'engine.description.claude_agent_sdk',
  codex_sdk: 'engine.description.codex_sdk',
  deepseek_harness: 'engine.description.deepseek_harness',
}

export const ENGINE_COLORS: Record<string, string> = {
  claude: '#d97757',
  codex: '#2563eb',
  hermes: '#18181b',
  opencode: '#006e7d',
  cursor: '#0f62fe',
  qoder_sdk: '#0891b2',
  openclaw: '#7c3aed',
  pydantic_ai: '#db2777',
  claude_agent_sdk: '#ea580c',
  codex_sdk: '#2563eb',
  deepseek_harness: '#4d6bfe',
}

const customMetadata = new Map<string, { name?: string; description?: string }>()
export function publishEngineMetadata(engines: readonly { id: string; name?: string; description?: string }[]) {
  for (const engine of engines) if (engine.name || engine.description) customMetadata.set(engine.id, engine)
}

export function engineLabel(id: string, t: TFunction = zhCNT) {
  return ENGINE_LABELS[id] ? t(ENGINE_LABELS[id]) : customMetadata.get(id)?.name || id
}

export function engineDescription(id: string, t: TFunction = zhCNT) {
  return ENGINE_DESCRIPTIONS[id] ? t(ENGINE_DESCRIPTIONS[id]) : customMetadata.get(id)?.description || t('engine.defaultDescription')
}

export function sortExecutionEngines<T extends { id: string; installed?: boolean }>(
  engines: readonly T[],
) {
  return [...engines].sort((a, b) => {
    const priorityA = EXECUTION_ENGINE_ORDER[a.id] ?? Number.MAX_SAFE_INTEGER
    const priorityB = EXECUTION_ENGINE_ORDER[b.id] ?? Number.MAX_SAFE_INTEGER
    return priorityA - priorityB || Number(Boolean(b.installed)) - Number(Boolean(a.installed))
  })
}
