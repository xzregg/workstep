import type { GitBranch } from '../../api/git'
import { useI18n } from '../../i18n'

/** Ordered-character matching lets e.g. 'ft pay' find 'feature/payment'. */
export function matchesBranchText(text: string, query: string) {
  text = text.toLocaleLowerCase()
  return query.toLocaleLowerCase().trim().split(/\s+/).every(part => {
    let cursor = 0
    for (const char of part) { const index = text.indexOf(char, cursor); if (index < 0) return false; cursor = index + 1 }
    return true
  })
}

function fuzzyScore(text: string, part: string) {
  let cursor = 0
  let first = -1
  let last = -1
  for (const char of part) {
    const index = text.indexOf(char, cursor)
    if (index < 0) return null
    if (first < 0) first = index
    last = index
    cursor = index + 1
  }
  return first + (last - first - part.length + 1)
}

/** Lower scores are more relevant; the branch name always outranks metadata matches. */
export function branchMatchScore(name: string, metadata: string, query: string) {
  const normalizedName = name.toLocaleLowerCase()
  const normalizedMetadata = metadata.toLocaleLowerCase()
  const parts = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean)
  if (!parts.length) return 0

  let score = 0
  for (const part of parts) {
    if (normalizedName === part) continue
    if (normalizedName.startsWith(part)) { score += 100 + normalizedName.length - part.length; continue }
    const nameIndex = normalizedName.indexOf(part)
    if (nameIndex >= 0) { score += 200 + nameIndex; continue }
    const nameFuzzy = fuzzyScore(normalizedName, part)
    if (nameFuzzy != null) { score += 400 + nameFuzzy; continue }

    if (normalizedMetadata === part) { score += 1000; continue }
    if (normalizedMetadata.startsWith(part)) { score += 1100 + normalizedMetadata.length - part.length; continue }
    const metadataIndex = normalizedMetadata.indexOf(part)
    if (metadataIndex >= 0) { score += 1200 + metadataIndex; continue }
    const metadataFuzzy = fuzzyScore(normalizedMetadata, part)
    if (metadataFuzzy != null) { score += 1400 + metadataFuzzy; continue }
    return null
  }
  return score
}

export function matchesBranch(branch: GitBranch, query: string) {
  return branchMatchScore(branch.name, `${branch.upstream || ''} ${branch.path || ''}`, query) != null
}

export default function GitBranchStatus({ branch }: { branch: GitBranch }) {
  const { t } = useI18n()
  const { ahead, behind, upstream, upstream_gone: gone } = branch
  const label = upstream === undefined ? t('git.syncUnknown') : !upstream ? t('git.noUpstream') : gone ? t('git.upstreamGone') : ahead == null || behind == null ? t('git.syncUnknown') : ahead && behind ? t('git.diverged', { ahead, behind }) : ahead ? t('git.ahead', { count: ahead }) : behind ? t('git.behind', { count: behind }) : t('git.synced')
  return <small className={`git-branch-sync ${gone || (ahead && behind) ? 'git-danger' : ''}`} title={upstream || undefined}>{label}</small>
}
