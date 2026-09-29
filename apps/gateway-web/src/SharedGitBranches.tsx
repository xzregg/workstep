import { useState } from 'react'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'

type Branch = { name: string; head: string; upstream: string | null; ahead: number | null;
  behind: number | null; occupied: boolean; worktree_id: string | null }
type RemoteBranch = { name: string; remote: string; branch: string; head: string }
type BranchList = { branches: Branch[]; remote_branches: RemoteBranch[] }
type Target = { action: 'switch' | 'delete'; branch: Branch }
  | { action: 'track'; branch: RemoteBranch }

function branchList(value: Partial<BranchList>): BranchList {
  return { branches: value.branches ?? [], remote_branches: value.remote_branches ?? [] }
}

export function SharedGitBranches({ base, treeId, alias, csrf, interactive, status, blocked,
  onStatusChanged }: {
  base: string; treeId: string; alias: string; csrf: string; interactive: boolean
  status?: { branch: string | null; snapshot: string; active?: boolean; operation?: string | null }
  blocked: boolean; onStatusChanged: () => Promise<void>
}) {
  const [list, setList] = useState<BranchList | null>(null)
  const [loading, setLoading] = useState(false)
  const [writing, setWriting] = useState(false)
  const [name, setName] = useState('')
  const [baseBranch, setBaseBranch] = useState('')
  const [target, setTarget] = useState<Target | null>(null)
  const [error, setError] = useState('')
  const canWrite = interactive && !!csrf && !!status && !status.active
    && !status.operation && !blocked && !writing && !loading

  async function load() {
    if (loading) return
    setLoading(true)
    setError('')
    try {
      const response = await fetch(`${base}/branches`)
      if (!response.ok) { setError('分支列表暂时不可用，请稍后重试。'); return }
      setList(branchList(await response.json() as Partial<BranchList>))
    } catch {
      setError('暂时无法连接宿主电脑，请稍后重试。')
    } finally {
      setLoading(false)
    }
  }

  async function fetchRemote() {
    if (!canWrite) return
    setWriting(true)
    setError('')
    try {
      const response = await fetch(`${base}/fetch`, {
        method: 'POST', headers: { 'X-Share-CSRF': csrf },
      })
      if (!response.ok) { setError('刷新远程分支失败，请稍后重试。'); return }
      setList(branchList(await response.json() as Partial<BranchList>))
    } catch {
      setError('暂时无法连接宿主电脑，请稍后重试。')
    } finally {
      setWriting(false)
    }
  }

  async function create() {
    const source = list?.branches.find(branch => branch.name === (baseBranch || status?.branch))
    const snapshot = status?.snapshot
    const nextName = name.trim()
    if (!canWrite || !source || !snapshot || !nextName) return
    setWriting(true)
    setError('')
    try {
      const response = await fetch(`${base}/branches`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Share-CSRF': csrf },
        body: JSON.stringify({ name: nextName, base_branch: source.name,
          base_head: source.head, snapshot }),
      })
      if (!response.ok) { setError('创建分支失败，请刷新状态和分支后重试。'); return }
      setName('')
      await load()
    } catch {
      setError('暂时无法连接宿主电脑，请稍后重试。')
    } finally {
      setWriting(false)
    }
  }

  async function apply() {
    const current = target
    const snapshot = status?.snapshot
    if (!current || writing || !snapshot) return
    setWriting(true)
    setError('')
    try {
      const endpoint = current.action === 'delete' ? 'branches/delete' : 'switch'
      const body = current.action === 'delete'
        ? { branch: current.branch.name, head: current.branch.head, snapshot }
        : current.action === 'track'
          ? { branch: current.branch.branch, snapshot, remote: current.branch.remote }
          : { branch: current.branch.name, snapshot }
      const response = await fetch(`${base}/${endpoint}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Share-CSRF': csrf },
        body: JSON.stringify(body),
      })
      setTarget(null)
      if (!response.ok) { setError('分支操作失败，请刷新状态和分支后重试。'); return }
      await onStatusChanged()
      await load()
    } catch {
      setTarget(null)
      setError('暂时无法连接宿主电脑，请稍后重试。')
    } finally {
      setWriting(false)
    }
  }

  const source = list?.branches.find(branch => branch.name === (baseBranch || status?.branch))
  return <div className="gateway-share-git-branches">
    <button type="button" disabled={loading || writing} onClick={() => void load()}>
      {loading && <span className="gateway-share-spinner" aria-hidden="true" />}
      查看 {alias} 分支
    </button>
    {error && <p className="gateway-share-error" role="alert">{error}</p>}
    {list && <>
      <h5>本地分支</h5>
      {list.branches.length === 0 ? <p>没有本地分支。</p>
        : <ul>{list.branches.map(branch => <li key={branch.name}>
          <strong>{branch.name}</strong> · {branch.head.slice(0, 8)}
          {branch.upstream && <> · 上游 {branch.upstream}</>}
          {branch.ahead != null && branch.behind != null
            && <> · 领先 {branch.ahead} / 落后 {branch.behind}</>}
          {branch.occupied && <> · 已检出</>}
          {interactive && status && !branch.occupied && !status.active && !status.operation
            && <span className="gateway-share-git-branch-actions">
              <button type="button" disabled={!canWrite}
                onClick={() => setTarget({ action: 'switch', branch })}>切换到 {branch.name}</button>
              <button type="button" disabled={!canWrite}
                onClick={() => setTarget({ action: 'delete', branch })}>删除 {branch.name} 分支</button>
            </span>}
        </li>)}</ul>}
      {interactive && status && !status.active && !status.operation && <div className="gateway-share-git-create">
        <label htmlFor={`gateway-share-branch-name-${treeId}`}>{alias} 新分支名称</label>
        <input id={`gateway-share-branch-name-${treeId}`} type="text" maxLength={255}
          value={name} onChange={event => setName(event.target.value)} />
        <label htmlFor={`gateway-share-branch-base-${treeId}`}>来源分支</label>
        <select id={`gateway-share-branch-base-${treeId}`}
          value={baseBranch || status.branch || ''}
          onChange={event => setBaseBranch(event.target.value)}>
          {list.branches.map(branch => <option key={branch.name} value={branch.name}>
            {branch.name}</option>)}
        </select>
        <button type="button" disabled={!canWrite || !name.trim() || !source}
          onClick={() => void create()}>
          {writing && <span className="gateway-share-spinner" aria-hidden="true" />}
          创建 {alias} 分支
        </button>
      </div>}
      <h5>远程分支</h5>
      {list.remote_branches.length === 0 ? <p>没有远程分支。</p>
        : <ul>{list.remote_branches.map(branch => <li key={branch.name}>
          <strong>{branch.name}</strong> · {branch.head.slice(0, 8)}
          {interactive && status && !list.branches.some(local => local.name === branch.branch)
            && <span className="gateway-share-git-branch-actions">
              <button type="button" disabled={!canWrite}
                onClick={() => setTarget({ action: 'track', branch })}>
                跟踪 {branch.name}
              </button>
            </span>}
        </li>)}</ul>}
      {interactive && <button type="button" disabled={!canWrite}
        onClick={() => void fetchRemote()}>
        {writing && <span className="gateway-share-spinner" aria-hidden="true" />}
        刷新 {alias} 远程分支
      </button>}
    </>}
    {target && <GatewayConfirmDialog
      title={target.action === 'switch' ? '确认切换分支'
        : target.action === 'delete' ? '确认删除分支' : '确认跟踪远程分支'}
      message={target.action === 'switch' ? `将 ${alias} 工作树切换到 ${target.branch.name}？`
        : target.action === 'delete' ? `删除 ${target.branch.name} 分支？仅已合并的分支可删除。`
          : `将 ${alias} 工作树切换到 ${target.branch.name}，并创建本地跟踪分支？`}
      confirmLabel={target.action === 'switch' ? '确认切换'
        : target.action === 'delete' ? '确认删除' : '确认跟踪'}
      busy={writing} onConfirm={() => void apply()} onCancel={() => setTarget(null)} />}
  </div>
}
