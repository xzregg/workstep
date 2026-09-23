import { request } from './client'

export interface GitFile { path: string; old_path: string | null; index_status: string; worktree_status: string; untracked: boolean; staged: boolean; conflict: boolean; submodule: boolean }
export interface GitWorktree { id: string; path: string; branch: string | null; head: string; main: boolean; available: boolean; locked: boolean; prunable: boolean }
export interface GitRepository { id: string; name: string; common_dir: string; worktrees: GitWorktree[]; projects: { id: string; relative_path: string }[] }
export interface GitDiscovery { projects: { id: string; name: string; path: string }[]; repositories: GitRepository[]; depth: number; scanned_at: number | null; errors: { path: string; message: string }[] }
export interface TaskGitWorktree extends GitWorktree { alias: string; repository_id: string; repository_name: string }
export interface TaskGitWorkspace { path: string; worktrees: TaskGitWorktree[] }
export interface GitStatus { id: string; path: string; head: string | null; branch: string | null; files: GitFile[]; snapshot: string; operation: string | null; active: boolean; ahead: number | null; behind: number | null; upstream: string | null }
export interface GitBranch { upstream?: string | null; upstream_gone?: boolean; remote?: string | null; ahead?: number | null; behind?: number | null; name: string; head: string; worktree_id: string | null; path: string | null }
export interface GitRemoteBranch { name: string; head: string }
export interface GitTrackedRemoteBranch { name: string; remote: string; branch: string; head: string }
export interface GitRemote { name: string; url: string; push_url: string; branches: GitRemoteBranch[] }
export interface GitRemotes { remotes: GitRemote[]; upstream: { remote: string; branch: string } | null; fetched_at: number | null }
export interface GitIdentity { name: string; email: string }
export interface GitCredentialStatus { remotes: { name: string; url: string; configured: boolean }[] }
export interface GitCommit { hash: string; author: string; time: number; message: string }
export interface GitDiff { path: string; old_path: string; base: string | null; target: string | null; patch: string; before: string; after: string; binary: boolean; truncated: boolean; submodule: boolean; snapshot?: string }
export interface BlameLine { line: number; hash: string; author: string; time: number; message: string }
export interface ScanJob { id: string; state: 'running' | 'complete' | 'failed' | 'superseded' | 'cancelled'; completed_projects: number; total_projects: number; error?: string }
export interface Comparison { ref?: string; commit?: string }
const query = (values: Record<string, string | number | undefined>) => '?' + new URLSearchParams(Object.entries(values).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))
const route = (id: string) => `/git/worktrees/${encodeURIComponent(id)}`
const post = (body?: unknown): RequestInit => ({ method: 'POST', body: body ? JSON.stringify(body) : undefined })
const del = (): RequestInit => ({ method: 'DELETE' })
export const gitApi = {
  taskWorkspace: (projectId: string, taskId: string) => request<TaskGitWorkspace>(`/git/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/workspace`),
  openTaskWorkspace: (projectId: string, taskId: string) => request<TaskGitWorkspace>(`/git/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/workspace`, post()),
  deleteTaskWorkspace: (projectId: string, taskId: string) => request<TaskGitWorkspace>(`/git/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/workspace`, del()),
  addTaskWorktree: (projectId: string, taskId: string, repositoryId: string, alias: string, baseRef: string, branchName: string) => request<TaskGitWorkspace>(`/git/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/worktrees`, post({ repository_id: repositoryId, alias, base_ref: baseRef, branch_name: branchName })),
  removeTaskWorktree: (projectId: string, taskId: string, alias: string) => request<TaskGitWorkspace>(`/git/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/worktrees/${encodeURIComponent(alias)}`, del()),
  scan: () => request<ScanJob>('/git/scans', post()),
  progress: (id: string) => request<ScanJob>(`/git/scans/${id}`),
  repositories: () => request<GitDiscovery>('/git/repositories'),
  initialize: (projectId: string) => request<{ project_id: string; path: string }>(`/git/projects/${encodeURIComponent(projectId)}/initialize`, post()),
  status: (id: string) => request<GitStatus>(route(id) + '/status'),
  branches: (id: string) => request<{ branches: GitBranch[]; remote_branches?: GitTrackedRemoteBranch[]; fetched_at?: number | null }>(route(id) + '/branches'),
  remotes: (id: string) => request<GitRemotes>(route(id) + '/remotes'),
  identity: (id: string) => request<GitIdentity>(route(id) + '/identity'),
  setIdentity: (id: string, identity: GitIdentity) => request<GitIdentity>(route(id) + '/identity', { method: 'PUT', body: JSON.stringify(identity) }),
  setGlobalIdentity: (id: string, identity: GitIdentity) => request<GitIdentity>(route(id) + '/identity/global', { method: 'PUT', body: JSON.stringify(identity) }),
  credentials: (id: string) => request<GitCredentialStatus>(route(id) + '/credentials'),
  saveCredentials: (id: string, remote: string, username: string, token: string) => request<GitCredentialStatus>(route(id) + '/credentials', { method: 'PUT', body: JSON.stringify({ remote, username, token }) }),
  clearCredentials: (id: string, remote: string) => request<GitCredentialStatus>(route(id) + '/credentials/' + encodeURIComponent(remote), { method: 'DELETE' }),
  history: (id: string, ref?: string, offset = 0) => request<{ commits: GitCommit[]; has_more: boolean }>(route(id) + '/history' + query({ ref, offset })),
  changes: (id: string, comparison: Comparison) => request<{ files: GitFile[] }>(route(id) + '/changes' + query({ ...comparison })),
  diff: (id: string, path: string, comparison: Comparison) => request<GitDiff>(route(id) + '/diff' + query({ path, ...comparison })),
  blame: (id: string, path: string, ref: string) => request<{ lines: BlameLine[] }>(route(id) + '/blame' + query({ path, ref })),
  commit: (id: string, paths: string[], message: string, snapshot: string) => request<{ head: string }>(route(id) + '/commit', post({ paths, message, snapshot })),
  discard: (id: string, path: string, snapshot: string) => request<GitStatus>(route(id) + '/discard', post({ path, snapshot })),
  ignore: (id: string, path: string, snapshot: string) => request<GitStatus>(route(id) + '/ignore', post({ path, snapshot })),
  saveFile: (id: string, path: string, content: string, snapshot: string) => request<GitStatus>(route(id) + '/files/content', post({ path, content, snapshot })),
  generateCommitMessage: (id: string, paths: string[], snapshot: string) => request<{ message: string }>(route(id) + '/commit-message', post({ paths, snapshot })),
  fetch: (id: string) => request<{ branches: GitBranch[]; remote_branches?: GitTrackedRemoteBranch[]; fetched_at?: number | null }>(route(id) + '/fetch', post()),
  fetchRemote: (id: string, remote: string) => request<GitRemotes>(route(id) + '/fetch-remote', post({ remote })),
  push: (id: string, branch: string, snapshot: string, target?: { remote: string; targetBranch: string; setUpstream: boolean }) => request<GitStatus>(route(id) + '/push', post({ branch, snapshot, remote: target?.remote, target_branch: target?.targetBranch, set_upstream: target?.setUpstream || false })),
  pull: (id: string, branch: string, snapshot: string, target?: { remote: string; targetBranch: string; setUpstream: boolean }) => request<GitStatus>(route(id) + '/pull', post({ branch, snapshot, remote: target?.remote, target_branch: target?.targetBranch, set_upstream: target?.setUpstream || false })),
  switch: (id: string, branch: string, snapshot: string, remote?: string) => request<GitStatus>(route(id) + '/switch', post({ branch, snapshot, remote })),
  advance: (id: string, branch: string, snapshot: string) => request<{ branches: GitBranch[]; remote_branches?: GitTrackedRemoteBranch[]; fetched_at?: number | null }>(route(id) + '/advance', post({ branch, snapshot })),
}
