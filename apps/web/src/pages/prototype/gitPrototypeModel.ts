// Throwaway UI prototype: synthetic Git data, no filesystem or Git mutations.
export type DiffLine = { old?: number; next?: number; before: string; after: string; changed?: boolean }
export type Hunk = { name: string; lines: DiffLine[] }
export type GitFile = { id: string; path: string; status: 'M' | 'A'; staged: boolean; added: number; removed: number; hunks: Hunk[] }
export type Commit = { hash: string; message: string; author: string; time: string }
export type Workspace = { files: GitFile[]; history: Commit[]; draft: string }
export const worktrees = [
  { id: 'main', repo: 'workstep', branch: 'main', path: '~/Desktop/workstep', label: '主工作目录', sync: '↑ 2 ↓ 0' },
  { id: 'feature', repo: 'workstep', branch: 'feat/git-panel', path: '~/worktrees/workstep/git-panel', label: 'Worktree', sync: '↑ 1 ↓ 0' },
  { id: 'scroll', repo: 'workstep', branch: 'fix/chat-scroll', path: '~/worktrees/workstep/chat-scroll', label: 'Worktree', sync: '已同步' },
  { id: 'cashier', repo: 'cashier_v4_dev', branch: 'staging', path: '~/Desktop/cashier_v4_dev', label: '主工作目录', sync: '↑ 0 ↓ 3' },
  { id: 'design', repo: 'design-system', branch: 'main', path: '~/Desktop/design-system', label: '主工作目录', sync: '未设置上游' },
]
export type Worktree = typeof worktrees[number]
export type BranchSwitchResult = { kind: 'current' } | { kind: 'dirty' } | { kind: 'occupied'; workspaceId: string } | { kind: 'switched'; trees: Worktree[] }
export function switchMockBranch(trees: Worktree[], spaces: Record<string, Workspace>, id: string, target: string): BranchSwitchResult {
  const current = trees.find(tree => tree.id === id)!
  if (current.branch === target) return { kind: 'current' }
  const occupied = trees.find(tree => tree.repo === current.repo && tree.branch === target)
  if (occupied) return { kind: 'occupied', workspaceId: occupied.id }
  if (spaces[id].files.length) return { kind: 'dirty' }
  return { kind: 'switched', trees: trees.map(tree => tree.id === id ? { ...tree, branch: target, sync: '未设置上游' } : tree) }
}
const runner: GitFile = {
  id: 'runner', path: 'apps/daemon/services/task_runner.py', status: 'M', staged: false, added: 8, removed: 4,
  hunks: [
    { name: 'execute_step()', lines: [
      { old: 124, next: 124, before: 'async def execute_step(project_id, step):', after: 'async def execute_step(project_id, step):' },
      { old: 125, next: 125, before: '    """Run a workflow step in its project."""', after: '    """Run a workflow step in its project."""' },
      { old: 126, next: 126, before: '    project = get_project(project_id)', after: '    project = await load_project(project_id)', changed: true },
      { old: 127, next: 127, before: '    context = build_context(project, step)', after: '    context = await asyncio.to_thread(', changed: true },
      { next: 128, before: '', after: '        build_context, project, step', changed: true },
      { next: 129, before: '', after: '    )', changed: true },
      { old: 128, next: 130, before: '', after: '' },
      { old: 129, next: 131, before: '    async with engine.session() as session:', after: '    async with engine.session() as session:' },
      { old: 130, next: 132, before: '        result = await session.run(context)', after: '        result = await session.run(context)' },
      { old: 131, next: 133, before: '        return result', after: '        return result' },
    ] },
    { name: 'load_project()', lines: [
      { old: 146, next: 148, before: 'def get_project(project_id):', after: 'async def load_project(project_id):', changed: true },
      { old: 147, next: 149, before: '    return project_manager.get(project_id)', after: '    return await asyncio.to_thread(', changed: true },
      { next: 150, before: '', after: '        project_manager.get, project_id', changed: true },
      { next: 151, before: '', after: '    )', changed: true },
    ] },
  ],
}
function smallFile(id: string, path: string, before: string, after: string, status: 'M' | 'A' = 'M'): GitFile {
  return { id, path, status, staged: false, added: 1, removed: status === 'A' ? 0 : 1,
    hunks: [{ name: path.endsWith('.py') ? 'test_event_loop_remains_responsive()' : '文件修改', lines: [
      { old: status === 'A' ? undefined : 1, next: 1, before, after, changed: true },
    ] }] }
}
export function initialWorkspaces(): Record<string, Workspace> {
  const history = [
    { hash: 'a3f82c1', message: 'refactor: 统一项目执行上下文', author: '陈予', time: '今天 10:42' },
    { hash: '79de604', message: 'fix: 修复任务停止后的状态更新', author: '林舟', time: '昨天 18:26' },
    { hash: 'd180b92', message: 'feat: 增加工作流阶段执行记录', author: '陈予', time: '9 月 18 日' },
  ]
  return Object.fromEntries(worktrees.map(tree => [tree.id, {
    draft: '', history: [...history], files: tree.id === 'feature' ? [structuredClone(runner),
      smallFile('test', 'apps/daemon/tests/test_task_runner.py', '', 'async def test_event_loop_remains_responsive():', 'A'),
      smallFile('docs', 'docs/architecture.md', '同步构建项目上下文。', '在专用线程中构建项目上下文。'),
    ] : tree.id === 'main' ? [smallFile('layout', 'apps/web/src/components/Layout.tsx', 'const width = 240', 'const width = 280'), smallFile('theme', 'apps/web/src/index.css', '--border-soft: #eeeeee;', '--border-soft: #eeeef0;')]
      : tree.id === 'cashier' ? [smallFile('pay', 'sdks/alipay.py', 'timeout = 10', 'timeout = 30')] : [],
  }]))
}
export function stageFile(workspace: Workspace, id: string, staged: boolean): Workspace {
  return { ...workspace, files: workspace.files.map(file => file.id === id ? { ...file, staged } : file) }
}
export function commitWorkspace(workspace: Workspace, message: string): Workspace {
  if (!message.trim() || !workspace.files.some(file => file.staged)) return workspace
  return { ...workspace, draft: '', files: workspace.files.filter(file => !file.staged),
    history: [{ hash: 'demo' + (workspace.history.length + 1), message: message.trim(), author: '你', time: '刚刚 · 模拟提交' }, ...workspace.history] }
}
