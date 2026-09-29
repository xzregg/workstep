import { useState } from 'react'
import { GatewayConfirmDialog } from './GatewayConfirmDialog'

type Worktree = { id: string; alias: string; repository_name: string; branch: string | null }
type Status = { branch: string | null; head: string | null; snapshot: string;
  files: Array<{ path: string; index_status: string; worktree_status: string }> }

export function SharedGitWorkspace({ base, csrf, interactive }: {
  base: string; csrf: string; interactive: boolean
}) {
  const [open, setOpen] = useState(false)
  const [worktrees, setWorktrees] = useState<Worktree[] | null>(null)
  const [statuses, setStatuses] = useState<Record<string, Status>>({})
  const [busy, setBusy] = useState(false)
  const [statusBusy, setStatusBusy] = useState<string | null>(null)
  const [selectedPaths, setSelectedPaths] = useState<Record<string, string[]>>({})
  const [commitMessages, setCommitMessages] = useState<Record<string, string>>({})
  const [commitTarget, setCommitTarget] = useState<Worktree | null>(null)
  const [commitBusy, setCommitBusy] = useState(false)
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
            || !commitMessages[tree.id]?.trim() || commitBusy}
            onClick={() => setCommitTarget(tree)}>提交选中文件</button>
        </div>}
      </div>}
    </article>)}
    {commitTarget && <GatewayConfirmDialog title="确认 Git 提交"
      message={`将 ${commitTarget.alias} 工作树中 ${(selectedPaths[commitTarget.id] ?? []).length} 个文件提交？`}
      confirmLabel="确认提交" busy={commitBusy} onConfirm={() => void commit()}
      onCancel={() => setCommitTarget(null)} />}
  </section>
}
