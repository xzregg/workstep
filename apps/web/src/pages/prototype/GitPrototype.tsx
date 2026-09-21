import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import Icon from '../../components/Icon'
import { BrandIcon } from '../../components/BrandIcon'
import ConfirmDialog from '../../components/ConfirmDialog'
import { useOverlay } from '../../hooks/useOverlay'
import GitScanSettings from '../GitScanSettings'
import { useUserSettingsStore } from '../../stores/userSettingsStore'
import GitBranchSwitcher from './GitBranchSwitcher'
import { commitWorkspace, initialWorkspaces, stageFile, switchMockBranch, worktrees as initialTrees, type GitFile, type Workspace } from './gitPrototypeModel'
import './GitPrototype.css'

// Throwaway variants on /prototype/git?variant=A|B|C; C combines the selected interactions. All state is synthetic and in memory.
function Overlay({ children, close, label, className = '' }: { children: ReactNode; close: () => void; label: string; className?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useOverlay(true, close, ref, false)
  return <div className={`gp-overlay ${className}`} onClick={close}>
    <div ref={ref} className="gp-window" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} onClick={event => event.stopPropagation()}>{children}</div>
  </div>
}

function DiffViewer({ file, historical = false, branchName = 'develop', baseBranch = 'main' }: { file: GitFile; historical?: boolean; branchName?: string; baseBranch?: string }) {
  const [blame, setBlame] = useState(true)
  const [unified, setUnified] = useState(() => window.matchMedia('(max-width: 600px)').matches)
  const [author, setAuthor] = useState<'陈予' | '林舟' | null>(null)
  const [hunk, setHunk] = useState(0)
  const body = useRef<HTMLDivElement>(null)
  useEffect(() => { setHunk(0); setAuthor(null) }, [file.id])
  useEffect(() => {
    const media = window.matchMedia('(max-width: 600px)')
    const change = () => { if (media.matches) setUnified(true) }
    media.addEventListener('change', change)
    return () => media.removeEventListener('change', change)
  }, [])
  const jump = (index: number) => {
    const next = (index + file.hunks.length) % file.hunks.length
    setHunk(next)
    body.current?.querySelectorAll('.gp-hunk')[next]?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }
  function code(text: string) {
    return text.split(/(\b(?:async|def|await|return|with|as|const)\b|""".*?"""|'.*?')/g).map((part, index) =>
      <span key={index} className={/^(async|def|await|return|with|as|const)$/.test(part) ? 'gp-keyword' : /^['"]/.test(part) ? 'gp-string' : undefined}>{part}</span>)
  }
  return <section className="gp-diff" aria-label="文件差异">
    <div className="gp-diff-path"><Icon name="file" size={15} /><strong>{file.path.split('/').at(-1)}</strong><span className="gp-muted gp-ellipsis">{file.path.split('/').slice(0, -1).join('/')}</span><span className="gp-grow" /><span className="gp-add">+{file.added}</span><span className="gp-delete">−{file.removed}</span></div>
    <div className="gp-diff-tools">
      <select aria-label="差异显示方式" value={unified ? 'unified' : 'split'} onChange={e => setUnified(e.target.value === 'unified')}><option value="split">左右对比</option><option value="unified">统一视图</option></select>
      <button className={blame ? 'is-active' : ''} onClick={() => setBlame(!blame)}><Icon name="clock" size={14} />修改人</button>
      <span className="gp-grow" />
      <select aria-label="跳转函数" value={hunk} onChange={e => jump(Number(e.target.value))}>{file.hunks.map((item, index) => <option key={item.name} value={index}>{item.name}</option>)}</select>
      <button aria-label="上一个修改" onClick={() => jump(hunk - 1)}><Icon name="chevron-down" className="gp-up" size={14} /></button>
      <span className="gp-muted">{hunk + 1}/{file.hunks.length}</span>
      <button aria-label="下一个修改" onClick={() => jump(hunk + 1)}><Icon name="chevron-down" size={14} /></button>
    </div>
    <div className="gp-revisions"><span><i className="gp-dot" />{historical ? `${baseBranch} · 比较基准` : 'HEAD · a3f82c1'}</span><span><i className="gp-dot green" />{historical ? `${branchName} · 分支版本` : '工作目录 · 当前版本'}</span></div>
    <div className={`gp-code-scroll ${unified ? 'unified' : ''} ${blame ? 'with-blame' : ''}`} ref={body}>
      {file.hunks.map((item, index) => <div className="gp-hunk" key={item.name}>
        <div className="gp-hunk-heading"><Icon name="terminal" size={13} /><span>@@ {item.name}</span><span className="gp-grow" /><span>{index + 1} / {file.hunks.length}</span></div>
        {item.lines.map((line, i) => <div className={`gp-code-pair ${line.changed ? 'changed' : ''}`} key={i}>
          <div className={`gp-code-line before ${!line.old ? 'vacant' : ''}`}>
            {blame && <button className="gp-blame" disabled={!line.old} title="查看此行上次修改" onClick={() => setAuthor('陈予')}>{line.old ? '陈予 · 09/18' : ''}</button>}
            <span className="gp-line-number">{line.old}</span><span className="gp-sign">{line.changed && line.old ? '−' : ''}</span><code>{code(line.before)}</code>
          </div>
          <div className={`gp-code-line after ${!line.next ? 'vacant' : ''}`}>
            {blame && <button className="gp-blame" disabled={line.changed && !historical} onClick={() => setAuthor(line.changed && historical ? '林舟' : '陈予')}>{line.changed ? historical ? '林舟 · 09/21' : '未提交' : '陈予 · 09/18'}</button>}
            <span className="gp-line-number">{line.next}</span><span className="gp-sign">{line.changed ? '+' : ''}</span><code>{code(line.after)}</code>
          </div>
        </div>)}
      </div>)}
      <div className="gp-end-code">文件末尾</div>
    </div>
    {author && <div className="gp-author-card"><div className="gp-avatar">{author[0]}</div><div><strong>{author}</strong><p>{author === '陈予' ? '2026 年 9 月 18 日 · 14:32' : '2026 年 9 月 21 日 · 10:42'}</p><p>{author === '陈予' ? 'refactor: 统一项目执行上下文' : 'fix: 隔离任务执行中的阻塞调用'}</p><code>{author === '陈予' ? 'a3f82c1' : '79de604'}</code><span className="gp-muted"> · 此行上次提交</span></div><button aria-label="关闭修改人详情" onClick={() => setAuthor(null)}><Icon name="x" size={15} /></button></div>}
    <footer className="gp-diff-footer"><Icon name="eye" size={13} />只读差异<span className="gp-grow" />UTF-8<span> {file.path.endsWith('.py') ? 'Python' : '文本'} </span></footer>
  </section>
}

function FilePanel({ workspace, selected, select, stage, draft, commit, busy }: {
  workspace: Workspace; selected: string; select: (id: string) => void; stage: (id: string, value: boolean) => void;
  draft: (value: string) => void; commit: () => void; busy: boolean;
}) {
  const [closed, setClosed] = useState<string[]>([])
  const staged = workspace.files.filter(file => file.staged)
  return <section className="gp-files" aria-label="提交文件列表">
    <div className="gp-section-title"><strong>更改</strong><span className="gp-count">{workspace.files.length}</span></div>
    <div className="gp-file-groups">
      {['已暂存', '未暂存', '未跟踪'].map(group => {
        const files = workspace.files.filter(file => group === '已暂存' ? file.staged : !file.staged && (group === '未跟踪' ? file.status === 'A' : file.status !== 'A'))
        return <div key={group} className="gp-file-group">
          <button className="gp-group-heading" onClick={() => setClosed(closed.includes(group) ? closed.filter(g => g !== group) : [...closed, group])}><Icon name={closed.includes(group) ? 'chevron-right' : 'chevron-down'} size={13} />{group}<span className="gp-grow" /><span>{files.length}</span></button>
          {!closed.includes(group) && files.map(file => <div key={file.id} className={`gp-file-row ${selected === file.id ? 'selected' : ''}`}>
            <button className="gp-file-select" onClick={() => select(file.id)}><Icon name="file" size={15} /><span><strong>{file.path.split('/').at(-1)}</strong><small>{file.path.split('/').slice(0, -1).join('/')}</small></span><b className={file.status === 'A' ? 'gp-add' : 'gp-modified'}>{file.status}</b></button>
            <button className="gp-stage" title={file.staged ? '取消暂存' : '暂存文件'} aria-label={`${file.staged ? '取消暂存' : '暂存'} ${file.path.split('/').at(-1)}`} onClick={() => stage(file.id, !file.staged)}><Icon name={file.staged ? 'minus' : 'plus'} size={14} /></button>
          </div>)}
        </div>
      })}
      {!workspace.files.length && <div className="gp-clean"><Icon name="check" size={25} /><strong>工作目录干净</strong><span>所有更改均已提交</span></div>}
    </div>
    <div className="gp-commit-form"><label htmlFor="gp-message">提交说明</label><textarea id="gp-message" value={workspace.draft} onChange={e => draft(e.target.value)} placeholder="简要描述这次修改…" /><p>{staged.length ? `${staged.length} 个文件已暂存` : '点击文件旁的 + 暂存更改'}</p><button className="gp-primary" disabled={busy || !staged.length || !workspace.draft.trim()} onClick={commit}><Icon name={busy ? 'loader-circle' : 'check'} className={busy ? 'gp-spin' : ''} size={16} />{busy ? '正在提交…' : `提交${staged.length ? ` ${staged.length} 个文件` : ''}`}</button><small>模拟提交 · 不会修改实际仓库</small></div>
  </section>
}

export default function GitPrototype() {
  const [params, setParams] = useSearchParams()
  const variant = params.get('variant') === 'A' ? 'A' : params.get('variant') === 'B' ? 'B' : 'C'
  const [worktrees, setWorktrees] = useState(initialTrees)
  const [branchPicker, setBranchPicker] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const scanDepth = useUserSettingsStore(state => state.gitScanDepth)
  const loadSettings = useUserSettingsStore(state => state.load)
  useEffect(() => { void loadSettings() }, [loadSettings])
  const [spaces, setSpaces] = useState(initialWorkspaces)
  const [selected, setSelected] = useState('feature')
  const [fileId, setFileId] = useState('runner')
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<string[]>([])
  const [tab, setTab] = useState<'changes' | 'history'>('changes')
  const [branch, setBranch] = useState<string | null>(null)
  const [modal, setModal] = useState(false)
  const [diffModal, setDiffModal] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [mobileTree, setMobileTree] = useState(false)
  const tree = worktrees.find(item => item.id === selected)!
  const workspace = spaces[selected]
  const branchNames = (repo: string) => [...new Set([...initialTrees.filter(item => item.repo === repo).map(item => item.branch), ...worktrees.filter(item => item.repo === repo).map(item => item.branch), ...(repo === 'workstep' ? ['develop', 'release/0.9'] : ['develop'])])]
  const availableBranches = (repo: string) => branchNames(repo).filter(name => !worktrees.some(item => item.repo === repo && item.branch === name))
  const file = workspace.files.find(item => item.id === fileId) || workspace.files[0]
  const historicalFile = initialWorkspaces().feature.files[0]
  const messageTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(messageTimer.current), [])
  function notify(message: string) { setNotice(message); clearTimeout(messageTimer.current); messageTimer.current = setTimeout(() => setNotice(''), 4200) }
  function switchVariant(value: string) { setParams({ variant: value }, { replace: true }); setModal(false); setDiffModal(false); setMobileTree(false); setBranchPicker(false) }
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement).closest('input, textarea, select, [contenteditable], [role="dialog"]')) return
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); setParams({ variant: (event.key === 'ArrowRight' ? { A: 'B', B: 'C', C: 'A' } : { A: 'C', B: 'A', C: 'B' })[variant] }, { replace: true }); setModal(false); setDiffModal(false); setBranchPicker(false) }
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [variant, setParams])
  const update = (value: Workspace) => setSpaces(current => ({ ...current, [selected]: value }))
  function pick(id: string, branchName: string | null = null) { setSelected(id); setBranch(branchName); setFileId(spaces[id].files[0]?.id || ''); setTab(branchName ? 'history' : 'changes'); setMobileTree(false); setBranchPicker(false); if (variant === 'B') setModal(true) }
  function checkout(name: string) {
    const result = switchMockBranch(worktrees, spaces, selected, name)
    if (result.kind === 'dirty') { notify('请先提交当前目录的修改，再切换分支'); return }
    if (result.kind === 'occupied') { pick(result.workspaceId); notify('已定位该分支所在的工作目录'); return }
    if (result.kind === 'current') { setBranchPicker(false); return }
    setWorktrees(result.trees)
    setBranch(null)
    setBranchPicker(false)
    setTab('changes')
    notify(`已模拟切换到 ${name} · 工作目录保持不变`)
  }
  function close() { if (workspace.draft.trim()) setConfirm(true); else setModal(false) }
  async function commit() {
    const target = selected
    const before = spaces[target]
    setBusy(true)
    await new Promise(resolve => setTimeout(resolve, 650))
    setSpaces(current => ({ ...current, [target]: commitWorkspace(before, before.draft) }))
    setBusy(false)
    notify('模拟提交成功 · 已更新该工作目录的提交历史')
  }
  const files = <FilePanel workspace={workspace} selected={file?.id || ''} select={id => { setFileId(id); if (variant !== 'A') setDiffModal(true) }} stage={(id, value) => update(stageFile(workspace, id, value))} draft={draft => update({ ...workspace, draft })} commit={commit} busy={busy} />
  const history = <div className="gp-history"><h3>{branch ? `${branch} 的提交记录` : '最近提交'}</h3>{workspace.history.map(item => <button key={item.hash} onClick={() => { if (branch) setTab('changes'); else notify(`${item.hash} · ${item.message}（模拟历史摘要）`) }}><span className="gp-history-node" /><div><strong>{item.message}</strong><p>{item.author} · {item.time}</p></div><code>{item.hash}</code></button>)}{branch && <p className="gp-history-hint">此分支尚未检出。可查看它与 {tree.branch} 的差异，浏览不会切换当前分支。</p>}</div>
  const title = <><div className="gp-context-row"><div className="gp-context"><span><Icon name="folder" size={16} />{tree.repo}<Icon name="chevron-right" size={13} /><strong><Icon name="git-fork" size={16} />{branch || tree.branch}</strong><span className="gp-tag">{branch ? '浏览分支 · 未检出' : tree.label}</span></span><p>{branch ? `比较基准：${tree.branch} · 当前目录：${tree.path}` : tree.path}</p></div><div className="gp-context-actions">{variant === 'C' && <button className={branchPicker ? 'is-active' : ''} aria-expanded={branchPicker} onClick={() => setBranchPicker(!branchPicker)}><Icon name="git-fork" size={15} />切换分支<Icon name="chevron-down" size={13} /></button>}</div></div>
    {variant === 'C' && branchPicker && <GitBranchSwitcher key={selected} current={tree} trees={worktrees} branches={branchNames(tree.repo)} dirty={!!workspace.files.length} busy={busy} onSwitch={checkout} onLocate={id => { pick(id); notify('已定位分支所在的工作目录，未执行检出') }} onClose={() => setBranchPicker(false)} />}
    <div className="gp-tabs"><button className={tab === 'changes' ? 'selected' : ''} onClick={() => setTab('changes')}>{branch ? '分支差异' : '待提交更改'}<span>{branch ? 1 : workspace.files.length}</span></button><button className={tab === 'history' ? 'selected' : ''} onClick={() => setTab('history')}>提交历史<span>{workspace.history.length}</span></button><span className="gp-grow" /><span className="gp-muted gp-sync">{branch ? `当前检出：${tree.branch}` : tree.sync}</span></div></>
  const branchFiles = <div className="gp-branch-diff-list"><div><h3>{branch} 与 {tree.branch} 的差异</h3><p>点击文件打开对比窗口。当前工作目录仍在 {tree.branch} 分支。</p></div><button onClick={() => setDiffModal(true)}><Icon name="file" size={17} /><strong>{historicalFile.path}</strong><span className="gp-grow" /><span className="gp-add">+{historicalFile.added}</span><span className="gp-delete">−{historicalFile.removed}</span><Icon name="external-link" size={15} /></button></div>
  const repositoryTree = <aside className={`gp-tree ${mobileTree ? 'mobile-open' : ''}`}>
    <div className="gp-tree-title"><strong>仓库</strong><span className="gp-count">3</span><span className="gp-grow" /><button title="刷新仓库" aria-label="刷新仓库" onClick={() => { setRefreshing(true); setTimeout(() => { setRefreshing(false); notify('已刷新 3 个仓库、2 个 Worktree · 模拟数据') }, 500) }}><Icon name="refresh" className={refreshing ? 'gp-spin' : ''} size={15} /></button></div>
    <label className="gp-search"><Icon name="search" size={14} /><input placeholder="搜索仓库、分支或路径" aria-label="搜索仓库、分支或路径" value={query} onChange={e => setQuery(e.target.value)} /></label>
    <div className="gp-tree-list">
      {[...new Set(worktrees.map(item => item.repo))].map(repo => {
        const trees = worktrees.filter(item => item.repo === repo)
        if (query && !trees.some(item => `${item.repo} ${item.branch} ${item.path}`.toLowerCase().includes(query.toLowerCase())) && !availableBranches(repo).some(name => name.toLowerCase().includes(query.toLowerCase()))) return null
        const expanded = !collapsed.includes(repo) || !!query
        return <div key={repo} className="gp-repository"><button className="gp-repo-heading" onClick={() => setCollapsed(expanded ? [...collapsed, repo] : collapsed.filter(item => item !== repo))}><Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={13} /><Icon name="folder-open" size={16} /><strong>{repo}</strong><span className="gp-grow" /><span className="gp-muted">{trees.reduce((sum, item) => sum + spaces[item.id].files.length, 0)}</span></button>
          {expanded && <>{trees.map((item, index) => <div key={item.id}>{index === 1 && <div className="gp-tree-label">Worktrees <span>{trees.length - 1}</span></div>}<button className={`gp-tree-item ${selected === item.id && !branch ? 'selected' : ''}`} onClick={() => pick(item.id)} title={item.path}><Icon name={index === 0 ? 'folder' : 'git-fork'} size={15} /><span><strong>{item.branch}</strong><small>{index === 0 ? item.label : item.path.replace('~/worktrees/workstep/', '…/')}</small></span><span className={`gp-tree-status ${spaces[item.id].files.length ? '' : 'clean'}`}>{spaces[item.id].files.length || <Icon name="check" size={13} />}</span></button></div>)}{availableBranches(repo).length > 0 && <><div className="gp-tree-label">其他分支</div>{availableBranches(repo).map(name => <button key={name} className={`gp-tree-item ${branch === name && tree.repo === repo ? 'selected' : ''}`} onClick={() => pick(tree.repo === repo ? selected : trees[0].id, name)}><Icon name="git-fork" size={15} /><span><strong>{name}</strong><small>未检出到工作目录</small></span></button>)}</>}</>}
        </div>
      })}
      {query && ![...worktrees.map(item => `${item.repo} ${item.branch} ${item.path}`), ...worktrees.flatMap(item => availableBranches(item.repo))].some(value => value.toLowerCase().includes(query.toLowerCase())) && <p className="gp-tree-empty">没有匹配的仓库或分支</p>}
    </div><div className="gp-tree-bottom"><Icon name="check" size={13} />已发现项目外的 2 个 Worktree<small>从项目根目录向下扫描 {scanDepth} 层</small><button onClick={() => setSettingsOpen(true)}>扫描设置</button></div>
  </aside>
  return <div className={`gp-root variant-${variant}`}>
    <nav className="gp-rail" aria-label="WorkStep 导航"><BrandIcon size={25} /><span className="gp-rail-item"><Icon name="bot" size={20} /></span><span className="gp-rail-item"><Icon name="workflow" size={20} /></span><span className="gp-rail-item"><Icon name="bar-chart" size={20} /></span><button className="gp-rail-item active" aria-label="全局 Git" onClick={() => { setModal(false); setDiffModal(false); setSettingsOpen(false) }}><Icon name="git-fork" size={21} /></button><span className="gp-grow" /><button className={`gp-rail-item ${settingsOpen ? 'active' : ''}`} aria-label="全局 Git 设置" onClick={() => setSettingsOpen(true)}><Icon name="settings" size={20} /></button><div className="gp-profile">X</div></nav>
    <div className="gp-shell"><header className="gp-global-header"><button className="gp-mobile-menu" aria-label="打开仓库列表" onClick={() => setMobileTree(!mobileTree)}><Icon name="menu" size={18} /></button><strong>Git</strong><span className="gp-header-divider" /><span>{variant === 'A' ? '全局工作台' : variant === 'B' ? '侧栏管理' : '工作目录与提交'}</span><span className="gp-grow" /><span className="gp-prototype-label">交互原型 · 模拟数据</span><a href="/">返回 WorkStep<Icon name="external-link" size={13} /></a></header>
      <div className="gp-body">{repositoryTree}
        {settingsOpen ? <main className="gp-settings-page"><button onClick={() => setSettingsOpen(false)}><Icon name="chevron-right" className="gp-back" size={15} />返回 Git 面板</button><p className="gp-real-settings-hint">此处为真实全局设置，保存后会写入本机配置文件。仓库列表仍为模拟数据。</p><GitScanSettings /></main> : variant !== 'B' ? <main className="gp-workspace">{title}<div className="gp-review">{tab === 'history' ? history : branch ? variant === 'C' ? branchFiles : <DiffViewer file={historicalFile} historical branchName={branch} baseBranch={tree.branch} /> : variant === 'C' ? files : <>{files}{file ? <DiffViewer file={file} /> : <div className="gp-empty"><Icon name="check" size={34} /><h2>所有更改已提交</h2><p>选择其他工作目录继续审阅，或查看提交历史。</p><button onClick={() => setTab('history')}>查看提交历史</button></div>}</>}</div></main>
          : <main className="gp-background"><div className="gp-background-header"><span>workstep</span><h1>研发工作区</h1><p>随时打开 Git 面板，审阅一个工作目录的修改。</p><button className="gp-primary" onClick={() => setModal(true)}><Icon name="git-fork" size={16} />审阅 {tree.branch}</button></div><div className="gp-task-heading"><strong>最近任务</strong><span className="gp-muted">项目上下文预览</span></div>{[{ title: '为 Git 管理面板梳理交互流程', status: '等待审阅', icon: 'eye' as const }, { title: '隔离任务执行中的阻塞调用', status: '已完成', icon: 'check' as const }, { title: '优化长对话的滚动体验', status: '已完成', icon: 'check' as const }].map(task => <div className="gp-task-row" key={task.title}><Icon name={task.icon} size={17} /><strong>{task.title}</strong><span>{task.status}</span></div>)}<div className="gp-background-tip"><Icon name="git-fork" size={20} /><p>从左侧选择一个分支或 Worktree<br /><span>提交面板会在当前工作区上方打开</span></p></div></main>}
      </div>
    </div>
    {variant === 'B' && modal && <Overlay close={close} label="提交更改"><div className="gp-window-title"><strong>提交更改</strong><span className="gp-muted">{tree.repo}</span><span className="gp-grow" /><button aria-label="关闭提交面板" onClick={close}><Icon name="x" size={18} /></button></div>{title}<div className="gp-review">{tab === 'history' ? history : branch ? <DiffViewer file={historicalFile} historical branchName={branch || undefined} baseBranch={tree.branch} /> : <>{files}<div className="gp-commit-overview"><div className="gp-overview-icon"><Icon name="git-fork" size={28} /></div><h2>审阅后，提交到 {tree.branch}</h2><p>点击左侧文件打开完整对比，<br />查看函数变更与每行的上次修改人。</p><div className="gp-overview-stats"><span><strong>{workspace.files.length}</strong>个更改文件</span><span><strong>{workspace.files.filter(f => f.staged).length}</strong>个已暂存</span></div>{file && <button onClick={() => setDiffModal(true)}><Icon name="file" size={15} />打开 {file.path.split('/').at(-1)}</button>}<small>{tree.path}</small></div></>}</div></Overlay>}
    {variant !== 'A' && diffModal && (branch || file) && <Overlay close={() => setDiffModal(false)} label="文件对比" className="gp-diff-overlay"><div className="gp-window-title"><button onClick={() => setDiffModal(false)}><Icon name="chevron-right" className="gp-back" size={15} />返回提交</button><span className="gp-grow" /><span className="gp-muted">{branch || tree.branch}</span>{!branch && file && <button onClick={() => update(stageFile(workspace, file.id, !file.staged))}><Icon name={file.staged ? 'check' : 'plus'} size={15} />{file.staged ? '已暂存 · 点击取消' : '暂存此文件'}</button>}<button aria-label="关闭文件对比" onClick={() => setDiffModal(false)}><Icon name="x" size={17} /></button></div><DiffViewer file={branch ? historicalFile : file!} historical={!!branch} branchName={branch || undefined} baseBranch={tree.branch} /></Overlay>}
    <div className="gp-switcher" aria-label="原型方案切换"><span>方案</span><button className={variant === 'A' ? 'selected' : ''} onClick={() => switchVariant('A')}>A · 全局工作台</button><button className={variant === 'B' ? 'selected' : ''} onClick={() => switchVariant('B')}>B · 侧栏与弹窗</button><button className={variant === 'C' ? 'selected' : ''} onClick={() => switchVariant('C')}>C · 融合方案</button><span className="gp-switch-hint">← → 切换</span></div>
    {notice && <div className="gp-toast" role="status"><Icon name="check" size={16} />{notice}</div>}
    <ConfirmDialog open={confirm} title="关闭提交面板？" message="提交说明尚未使用，关闭后仍会在本次原型会话中保留。" confirmText="保留草稿并关闭" onCancel={() => setConfirm(false)} onConfirm={() => { setConfirm(false); setModal(false) }} />
  </div>
}
