interface ImportCandidateSelection {
  id: string
  source_type: string
  error: string | null
  already_exists: boolean
}

interface ImportCandidateCategory {
  id: string
  source_type: string
}

const SOURCE_TYPE_LABELS: Record<string, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  gemini: 'Gemini',
  hermes: 'Hermes',
  openclaw: 'OpenClaw',
  opencode: 'OpenCode',
  cursor: 'Cursor',
}

const SOURCE_TYPE_ORDER = Object.keys(SOURCE_TYPE_LABELS)

export function providerImportTabs<T extends ImportCandidateCategory>(
  candidates: T[],
  allLabel = '全部',
): Array<{ id: string; label: string; count: number }> {
  const counts = new Map<string, number>()
  for (const candidate of candidates) {
    counts.set(candidate.source_type, (counts.get(candidate.source_type) ?? 0) + 1)
  }
  const sourceTypes = [
    ...SOURCE_TYPE_ORDER.filter((sourceType) => counts.has(sourceType)),
    ...[...counts.keys()]
      .filter((sourceType) => !SOURCE_TYPE_LABELS[sourceType])
      .sort((left, right) => left.localeCompare(right)),
  ]
  return [
    { id: 'all', label: allLabel, count: candidates.length },
    ...sourceTypes.map((sourceType) => ({
      id: sourceType,
      label: SOURCE_TYPE_LABELS[sourceType] ?? sourceType,
      count: counts.get(sourceType) ?? 0,
    })),
  ]
}

export function filterProviderImportCandidates<T extends ImportCandidateCategory>(
  candidates: T[],
  sourceType: string,
): T[] {
  return sourceType === 'all'
    ? candidates
    : candidates.filter((candidate) => candidate.source_type === sourceType)
}

export function toggleProviderImportSelection(
  selectedIds: string[],
  candidateId: string,
): string[] {
  return selectedIds.includes(candidateId)
    ? selectedIds.filter((id) => id !== candidateId)
    : [...selectedIds, candidateId]
}

export function selectableProviderImportIds(
  candidates: ImportCandidateSelection[],
): string[] {
  return candidates
    .filter((candidate) => !candidate.error && !candidate.already_exists)
    .map((candidate) => candidate.id)
}
