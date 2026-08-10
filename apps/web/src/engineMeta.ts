import { zhCNT, type TFunction, type TKey } from './i18n'

export const ENGINE_LABELS: Record<string, TKey> = {
  claude: 'engine.label.claude',
  codex: 'engine.label.codex',
  hermes: 'engine.label.hermes',
  qoder_sdk: 'engine.label.qoder_sdk',
  openclaw: 'engine.label.openclaw',
  api: 'engine.label.api',
  pydantic_ai: 'engine.label.pydantic_ai',
  claude_agent_sdk: 'engine.label.claude_agent_sdk',
  codex_sdk: 'engine.label.codex_sdk',
}

export const ENGINE_DESCRIPTIONS: Record<string, TKey> = {
  claude: 'engine.description.claude',
  codex: 'engine.description.codex',
  hermes: 'engine.description.hermes',
  qoder_sdk: 'engine.description.qoder_sdk',
  openclaw: 'engine.description.openclaw',
  api: 'engine.description.api',
  pydantic_ai: 'engine.description.pydantic_ai',
  claude_agent_sdk: 'engine.description.claude_agent_sdk',
  codex_sdk: 'engine.description.codex_sdk',
}

export const ENGINE_COLORS: Record<string, string> = {
  claude: '#d97757',
  codex: '#2563eb',
  hermes: '#18181b',
  qoder_sdk: '#0891b2',
  openclaw: '#7c3aed',
  api: '#db2777',
  pydantic_ai: '#db2777',
  claude_agent_sdk: '#ea580c',
  codex_sdk: '#2563eb',
}

export function engineLabel(id: string, t: TFunction = zhCNT) {
  return ENGINE_LABELS[id] ? t(ENGINE_LABELS[id]) : id
}

export function engineDescription(id: string, t: TFunction = zhCNT) {
  return ENGINE_DESCRIPTIONS[id] ? t(ENGINE_DESCRIPTIONS[id]) : t('engine.defaultDescription')
}
