import type { GitBranch } from '../../api/git'
import { useI18n } from '../../i18n'

/** Ordered-character matching lets e.g. 'ft pay' find 'feature/payment'. */
export function matchesBranch(branch: GitBranch, query: string) {
  const text = `${branch.name} ${branch.upstream || ''} ${branch.path || ''}`.toLocaleLowerCase()
  return query.toLocaleLowerCase().trim().split(/\s+/).every(part => {
    let cursor = 0
    for (const char of part) { const index = text.indexOf(char, cursor); if (index < 0) return false; cursor = index + 1 }
    return true
  })
}

export default function GitBranchStatus({ branch }: { branch: GitBranch }) {
  const { t } = useI18n()
  const { ahead, behind, upstream, upstream_gone: gone } = branch
  const label = upstream === undefined ? t('git.syncUnknown') : !upstream ? t('git.noUpstream') : gone ? t('git.upstreamGone') : ahead == null || behind == null ? t('git.syncUnknown') : ahead && behind ? t('git.diverged', { ahead, behind }) : ahead ? t('git.ahead', { count: ahead }) : behind ? t('git.behind', { count: behind }) : t('git.synced')
  return <small className={`git-branch-sync ${gone || (ahead && behind) ? 'git-danger' : ''}`} title={upstream || undefined}>{label}</small>
}
