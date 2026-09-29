import { useState } from 'react'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'

type Worktree = { id: string; alias: string; repository_name: string; branch: string | null }
type Status = { branch: string | null; head: string | null; snapshot: string; active?: boolean;
  operation?: string | null;
  files: Array<{ path: string; index_status: string; worktree_status: string }> }
type Branch = { name: string; head: string; upstream: string | null; ahead: number | null;
  behind: number | null; occupied: boolean; worktree_id: string | null }
type SyncAction = 'pull' | 'push'

export function SharedGitWorkspace({ base, csrf, interactive }: {
  base: string; csrf: string; interactive: boolean
}) {
  const [open, setOpen] = useState(false)
  const [worktrees, setWorktrees] = useState<Worktree[] | null>(null)
  const [statuses, setStatuses] = useState<Record<string, Status>>({})
  const [branches, setBranches] = useState<Record<string, Branch[]>>({})
  const [newBranchNames, setNewBranchNames] = useState<Record<string, string>>({})
  const [baseBranches, setBaseBranches] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [statusBusy, setStatusBusy] = useState<string | null>(null)
  const [branchesBusy, setBranchesBusy] = useState<string | null>(null)
  const [branchWriteBusy, setBranchWriteBusy] = useState(false)
  const [branchTarget, setBranchTarget] = useState<{
    tree: Worktree; branch: Branch; action: 'switch' | 'delete'
  } | null>(null)
  const [selectedPaths, setSelectedPaths] = useState<Record<string, string[]>>({})
  const [commitMessages, setCommitMessages] = useState<Record<string, string>>({})
  const [commitTarget, setCommitTarget] = useState<Worktree | null>(null)
  const [commitBusy, setCommitBusy] = useState(false)
  const [syncTarget, setSyncTarget] = useState<{ tree: Worktree; action: SyncAction } | null>(null)
  const [syncBusy, setSyncBusy] = useState(false)
  const [error, setError] = useState('')

  async function toggle() {
    if (open) { setOpen(false); return }
    if (worktrees) { setOpen(true); return }
    setBusy(true)
    setError('')
    try {
      const response = await fetch(`${base}/git/workspace`)
      if (!response.ok) { setError('工作区暂时不可用，请稍后重试。'); return }
      const result = await response.json() as { worktrees: Worktree[] }
      setWorktrees(result.worktrees)
      setOpen(true)
    } catch {
      setError('暂时无法连接宿主电脑，请稍后重试。')
    } finally {
      setBusy(false)
    }
  }

  async function loadStatus(tree: Worktree) {
    if (statusBusy) return
    setStatusBusy(tree.id)
    setError('')
    try {
      const response = await fetch(`${base}/git/worktrees/${tree.id}/status`)
      if (!response.ok) { setError('工作树状态暂时不可用，请稍后重试。'); return }
      const result = await response.json() as Status
      setStatuses(current => ({ ...current, [tree.id]: result }))
      setSelectedPaths(current => ({ ...current, [tree.id]: [] }))
    } catch {
      setError('暂时无法连接宿主电脑，请稍后重试。')
    } finally {
      setStatusBusy(null)
    }
  }

  async function loadBranches(tree: Worktree) {
    if (branchesBusy) return
    setBranchesBusy(tree.id)
    setError('')
    try {
      const response = await fetch(`${base}/git/worktrees/${tree.id}/branches`)
      if (!response.ok) { setError('分支列表暂时不可用，请稍后重试。'); return }
      const result = await response.json() as { branches: Branch[] }
      setBranches(current => ({ ...current, [tree.id]: result.branches }))
    } catch {
      setError('暂时无法连接宿主电脑，请稍后重试。')
    } finally {
      setBranchesBusy(null)
    }
  }

  async function createBranch(tree: Worktree) {
    if (branchWriteBusy) return
    const name = newBranchNames[tree.id]?.trim()
    const base = baseBranches[tree.id] || statuses[tree.id]?.branch
    const source = branches[tree.id]?.find(branch => branch.name === base)
    const snapshot = statuses[tree.id]?.snapshot
    if (!name || !source || !snapshot) return
    setBranchWriteBusy(true)
    setError('')
    try {
      const response = await fetch(`${baseUrl(tree)}/branches`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Share-CSRF': csrf },
        body: JSON.stringify({ name, base_branch: source.name, base_head: source.head, snapshot }),
      })
      if (!response.ok) { setError('创建分支失败，请刷新状态和分支后重试。'); return }
      setNewBranchNames(current => ({ ...current, [tree.id]: '' }))
      await loadBranches(tree)
    } catch {
      setError('暂时无法连接宿主电脑，请稍后重试。')
    } finally {
      setBranchWriteBusy(false)
    }
  }

  async function writeBranch() {
    const target = branchTarget
    if (!target || branchWriteBusy) return
    const snapshot = statuses[target.tree.id]?.snapshot
    if (!snapshot) return
    setBranchWriteBusy(true)
    setError('')
    try {
      const endpoint = target.action === 'switch' ? 'switch' : 'branches/delete'
      const body = target.action === 'switch'
        ? { branch: target.branch.name, snapshot }
        : { branch: target.branch.name, head: target.branch.head, snapshot }
      const response = await fetch(`${baseUrl(target.tree)}/${endpoint}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Share-CSRF': csrf },
        body: JSON.stringify(body),
      })
      setBranchTarget(null)
      if (!response.ok) { setError('分支操作失败，请刷新状态和分支后重试。'); return }
      await loadStatus(target.tree)
      await loadBranches(target.tree)
    } catch {
      setBranchTarget(null)
      setError('暂时无法连接宿主电脑，请稍后重试。')
    } finally {
      setBranchWriteBusy(false)
    }
  }

  function baseUrl(tree: Worktree) { return `${base}/git/worktrees/${tree.id}` }

  async function commit() {
    const tree = commitTarget
    if (!tree || commitBusy) return
    const paths = selectedPaths[tree.id] ?? []
    const message = commitMessages[tree.id]?.trim() ?? ''
    const snapshot = statuses[tree.id]?.snapshot
    if (!paths.length || !message || !snapshot) return
    setCommitBusy(true)
    setError('')
    try {
      const response = await fetch(`${base}/git/worktrees/${tree.id}/commit`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Share-CSRF': csrf },
        body: JSON.stringify({ paths, message, snapshot }),
      })
      if (!response.ok) {
        setCommitTarget(null)
        setError('提交失败，请刷新状态后重试。')
        return
      }
      setCommitTarget(null)
      setCommitMessages(current => ({ ...current, [tree.id]: '' }))
      await loadStatus(tree)
    } catch {
      setCommitTarget(null)
      setError('暂时无法连接宿主电脑，请稍后重试。')
    } finally {
      setCommitBusy(false)
    }
  }

  async function sync() {
    const target = syncTarget
    if (!target || syncBusy) return
    const status = statuses[target.tree.id]
    if (!status?.branch || !status.snapshot) return
    setSyncBusy(true)
    setError('')
    try {
      const response = await fetch(`${base}/git/worktrees/${target.tree.id}/${target.action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Share-CSRF': csrf },
        body: JSON.stringify({ branch: status.branch, snapshot: status.snapshot }),
      })
      setSyncTarget(null)
      if (!response.ok) { setError('同步失败，请刷新状态后重试。'); return }
      await loadStatus(target.tree)
    } catch {
      setSyncTarget(null)
      setError('暂时无法连接宿主电脑，请稍后重试。')
    } finally {
      setSyncBusy(false)
    }
  }

  return <section className="gateway-share-messages gateway-share-git">
    <h3>Git 工作区</h3>
    <button type="button" disabled={busy} aria-expanded={open} onClick={() => void toggle()}>
      {busy && <span className="gateway-share-spinner" aria-hidden="true" />}
      {open ? '收起 Git 工作区' : busy ? '正在读取…' : '查看 Git 工作区'}
    </button>
    {error && <p className="gateway-share-error" role="alert">{error}</p>}
    {open && worktrees?.length === 0 && <p>此任务没有 Git 工作树。</p>}
    {open && worktrees?.map(tree => <article key={tree.id} className="gateway-share-git-tree">
      <h4>{tree.repository_name} · {tree.alias} · {statuses[tree.id]?.branch || tree.branch || '未命名分支'}</h4>
      <button type="button" disabled={statusBusy !== null}
        onClick={() => void loadStatus(tree)}>
        {statusBusy === tree.id && <span className="gateway-share-spinner" aria-hidden="true" />}
        查看 {tree.alias} 状态
      </button>
      <button type="button" disabled={branchesBusy !== null}
        onClick={() => void loadBranches(tree)}>
        {branchesBusy === tree.id && <span className="gateway-share-spinner" aria-hidden="true" />}
        查看 {tree.alias} 分支
      </button>
      {branches[tree.id] && <div className="gateway-share-git-branches">
        <h5>本地分支</h5>
        {branches[tree.id].length === 0 ? <p>没有本地分支。</p>
          : <ul>{branches[tree.id].map(branch => <li key={branch.name}>
            <strong>{branch.name}</strong> · {branch.head.slice(0, 8)}
            {branch.upstream && <> · 上游 {branch.upstream}</>}
            {branch.ahead != null && branch.behind != null
              && <> · 领先 {branch.ahead} / 落后 {branch.behind}</>}
            {branch.occupied && <> · 已检出</>}
            {interactive && statuses[tree.id] && !branch.occupied && !statuses[tree.id].active
              && !statuses[tree.id].operation
              && <span className="gateway-share-git-branch-actions">
                <button type="button" disabled={!csrf || branchWriteBusy || commitBusy || syncBusy}
                  onClick={() => setBranchTarget({ tree, branch, action: 'switch' })}>
                  切换到 {branch.name}
                </button>
                <button type="button" disabled={!csrf || branchWriteBusy || commitBusy || syncBusy}
                  onClick={() => setBranchTarget({ tree, branch, action: 'delete' })}>
                  删除 {branch.name} 分支
                </button>
              </span>}
          </li>)}</ul>}
        {interactive && statuses[tree.id] && !statuses[tree.id].active
          && !statuses[tree.id].operation && <div className="gateway-share-git-create">
          <label htmlFor={`gateway-share-branch-name-${tree.id}`}>{tree.alias} 新分支名称</label>
          <input id={`gateway-share-branch-name-${tree.id}`} type="text" maxLength={255}
            value={newBranchNames[tree.id] ?? ''}
            onChange={event => setNewBranchNames(current => ({ ...current,
              [tree.id]: event.target.value }))} />
          <label htmlFor={`gateway-share-branch-base-${tree.id}`}>来源分支</label>
          <select id={`gateway-share-branch-base-${tree.id}`}
            value={baseBranches[tree.id] || statuses[tree.id].branch || ''}
            onChange={event => setBaseBranches(current => ({ ...current,
              [tree.id]: event.target.value }))}>
            {branches[tree.id].map(branch => <option key={branch.name} value={branch.name}>
              {branch.name}</option>)}
          </select>
          <button type="button" disabled={!csrf || !newBranchNames[tree.id]?.trim()
            || !branches[tree.id].some(branch => branch.name === (
              baseBranches[tree.id] || statuses[tree.id].branch)) || branchWriteBusy
            || commitBusy || syncBusy}
            onClick={() => void createBranch(tree)}>
            {branchWriteBusy && <span className="gateway-share-spinner" aria-hidden="true" />}
            创建 {tree.alias} 分支
          </button>
        </div>}
      </div>}
      {statuses[tree.id] && <div className="gateway-share-git-status">
        <p>分支：{statuses[tree.id].branch || '未命名'} · 提交：{statuses[tree.id].head || '暂无'}</p>
        {statuses[tree.id].files.length === 0 ? <p>没有未提交的文件变更。</p>
          : <ul>{statuses[tree.id].files.map(file => <li key={file.path}>
            {interactive && <label><input type="checkbox" aria-label={`选择 ${file.path}`}
              checked={(selectedPaths[tree.id] ?? []).includes(file.path)}
              onChange={event => setSelectedPaths(current => ({ ...current,
                [tree.id]: event.target.checked
                  ? [...(current[tree.id] ?? []), file.path]
                  : (current[tree.id] ?? []).filter(path => path !== file.path),
              }))} /> </label>}
            <code>{file.index_status}{file.worktree_status}</code> {file.path}
          </li>)}</ul>}
        {interactive && statuses[tree.id].files.length > 0 && <div className="gateway-share-git-commit">
          <label htmlFor={`gateway-share-git-message-${tree.id}`}>{tree.alias} 提交说明</label>
          <input id={`gateway-share-git-message-${tree.id}`} type="text"
            value={commitMessages[tree.id] ?? ''} maxLength={100000}
            onChange={event => setCommitMessages(current => ({ ...current,
              [tree.id]: event.target.value }))} />
          <button type="button" disabled={!csrf || !(selectedPaths[tree.id]?.length)
            || !commitMessages[tree.id]?.trim() || commitBusy || branchWriteBusy || syncBusy}
            onClick={() => setCommitTarget(tree)}>提交选中文件</button>
        </div>}
        {interactive && statuses[tree.id].branch && <div className="gateway-share-git-sync">
          <button type="button" disabled={!csrf || !!statuses[tree.id].active || statusBusy !== null
            || commitBusy || syncBusy || branchWriteBusy} onClick={() => setSyncTarget({ tree, action: 'pull' })}>
            拉取 {tree.alias}
          </button>
          <button type="button" disabled={!csrf || !!statuses[tree.id].active || statusBusy !== null
            || commitBusy || syncBusy || branchWriteBusy} onClick={() => setSyncTarget({ tree, action: 'push' })}>
            推送 {tree.alias}
          </button>
        </div>}
      </div>}
    </article>)}
    {commitTarget && <GatewayConfirmDialog title="确认 Git 提交"
      message={`将 ${commitTarget.alias} 工作树中 ${(selectedPaths[commitTarget.id] ?? []).length} 个文件提交？`}
      confirmLabel="确认提交" busy={commitBusy} onConfirm={() => void commit()}
      onCancel={() => setCommitTarget(null)} />}
    {syncTarget && <GatewayConfirmDialog
      title={`确认 Git ${syncTarget.action === 'pull' ? '拉取' : '推送'}`}
      message={`${syncTarget.action === 'pull' ? '从上游拉取并快进' : '向上游推送'} ${syncTarget.tree.alias} 当前分支？`}
      confirmLabel={`确认${syncTarget.action === 'pull' ? '拉取' : '推送'}`}
      busy={syncBusy} onConfirm={() => void sync()} onCancel={() => setSyncTarget(null)} />}
    {branchTarget && <GatewayConfirmDialog
      title={branchTarget.action === 'switch' ? '确认切换分支' : '确认删除分支'}
      message={branchTarget.action === 'switch'
        ? `将 ${branchTarget.tree.alias} 工作树切换到 ${branchTarget.branch.name}？`
        : `删除 ${branchTarget.branch.name} 分支？仅已合并的分支可删除。`}
      confirmLabel={branchTarget.action === 'switch' ? '确认切换' : '确认删除'}
      busy={branchWriteBusy} onConfirm={() => void writeBranch()}
      onCancel={() => setBranchTarget(null)} />}
  </section>
}
