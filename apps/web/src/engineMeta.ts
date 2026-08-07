export const ENGINE_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  hermes: 'Hermes',
  qoder_sdk: 'Qoder Agent SDK',
  openclaw: 'OpenClaw',
  api: 'API / BYOK',
  pydantic_ai: 'Pydantic AI',
  claude_agent_sdk: 'Claude Agent SDK',
  codex_sdk: 'Codex Agent SDK',
}

export const ENGINE_DESCRIPTIONS: Record<string, string> = {
  claude: 'Anthropic 官方编码 CLI',
  codex: 'OpenAI 官方编码 CLI',
  hermes: 'Hermes ACP 执行引擎',
  qoder_sdk: 'Qoder 官方 Agent SDK，内嵌驱动 qodercli',
  openclaw: 'OpenClaw 本机执行引擎',
  api: '直连 OpenAI-compatible 或 Anthropic API',
  pydantic_ai: '内置 Python Agent，由 Pydantic AI 加载 Provider',
  claude_agent_sdk: 'Anthropic 官方 Agent SDK，内嵌驱动 Claude Code',
  codex_sdk: 'OpenAI 官方 Codex SDK，内嵌驱动 Codex',
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

export function engineLabel(id: string) {
  return ENGINE_LABELS[id] || id
}
