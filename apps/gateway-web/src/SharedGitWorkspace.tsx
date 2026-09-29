import { useState } from 'react'

type Worktree = { id: string; alias: string; repository_name: string; branch: string | null }
type Status = { branch: string | null; head: string | null;
  files: Array<{ path: string; index_status: string; worktree_status: string }> }

export function SharedGitWorkspace({ base }: { base: string }) {
  const [open, setOpen] = useState(false)
  const [worktrees, setWorktrees] = useState<Worktree[] | null>(null)
  const [statuses, setStatuses] = useState<Record<string, Status>>({})
  const [busy, setBusy] = useState(false)
  const [statusBusy, setStatusBusy] = useState<string | null>(null)
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
    } catch {
      setError('暂时无法连接宿主电脑，请稍后重试。')
    } finally {
      setStatusBusy(null)
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
      <h4>{tree.repository_name} · {tree.alias} · {tree.branch || '未命名分支'}</h4>
      <button type="button" disabled={statusBusy !== null}
        onClick={() => void loadStatus(tree)}>
        {statusBusy === tree.id && <span className="gateway-share-spinner" aria-hidden="true" />}
        查看 {tree.alias} 状态
      </button>
      {statuses[tree.id] && <div className="gateway-share-git-status">
        <p>分支：{statuses[tree.id].branch || '未命名'} · 提交：{statuses[tree.id].head || '暂无'}</p>
        {statuses[tree.id].files.length === 0 ? <p>没有未提交的文件变更。</p>
          : <ul>{statuses[tree.id].files.map(file => <li key={file.path}>
            <code>{file.index_status}{file.worktree_status}</code> {file.path}
          </li>)}</ul>}
      </div>}
    </article>)}
  </section>
}
