export const ENGINE_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  hermes: 'Hermes',
  qoder: 'Qoder CLI',
  qcode: 'QCode',
  openclaw: 'OpenClaw',
  api: 'API / BYOK',
}

export const ENGINE_DESCRIPTIONS: Record<string, string> = {
  claude: 'Anthropic 官方编码 CLI',
  codex: 'OpenAI 官方编码 CLI',
  hermes: 'Hermes ACP 执行引擎',
  qoder: 'Qoder ACP 执行引擎',
  qcode: 'QCode 本机执行引擎',
  openclaw: 'OpenClaw 本机执行引擎',
  api: '通过 API 密钥直接调用模型',
}

export const ENGINE_COLORS: Record<string, string> = {
  claude: '#d97757',
  codex: '#2563eb',
  hermes: '#18181b',
  qoder: '#16a34a',
  qcode: '#0891b2',
  openclaw: '#7c3aed',
  api: '#db2777',
}

export function engineLabel(id: string) {
  return ENGINE_LABELS[id] || id
}
