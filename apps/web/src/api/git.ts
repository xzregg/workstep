import { request } from './client'

export interface GitFile { path: string; old_path: string | null; index_status: string; worktree_status: string; untracked: boolean; staged: boolean; conflict: boolean; submodule: boolean }
export interface GitWorktree { id: string; path: string; branch: string | null; head: string; main: boolean; available: boolean; locked: boolean; prunable: boolean }
export interface GitRepository { id: string; name: string; common_dir: string; worktrees: GitWorktree[]; projects: { id: string; relative_path: string }[] }
export interface GitDiscovery { projects: { id: string; name: string; path: string }[]; repositories: GitRepository[]; depth: number; scanned_at: number | null; errors: { path: string; message: string }[] }
export interface TaskGitWorktree extends GitWorktree { alias: string; repository_id: string; repository_name: string; created_branch?: string | null; relative_path?: string }
export interface TaskGitWorkspace { path: string; relative_path?: string; worktrees: TaskGitWorktree[] }
export type TaskGitWorkspaceDeletion = TaskGitWorkspace & ({ outcome: 'deleted'; removed_aliases: string[] } | { outcome: 'partial'; removed_aliases: string[]; failure: string })
export interface GitStatus { id: string; path: string; head: string | null; branch: string | null; files: GitFile[]; snapshot: string; operation: string | null; active: boolean; ahead: number | null; behind: number | null; upstream: string | null }
export interface GitBranch { upstream?: string | null; upstream_gone?: boolean; remote?: string | null; ahead?: number | null; behind?: number | null; name: string; head: string; worktree_id: string | null; path: string | null }
export interface GitRemoteBranch { name: string; head: string }
export interface GitTrackedRemoteBranch { name: string; remote: string; branch: string; head: string }
export interface GitRemote { name: string; url: string; push_url: string; branches: GitRemoteBranch[] }
export interface GitRemotes { remotes: GitRemote[]; upstream: { remote: string; branch: string } | null; fetched_at: number | null }
export interface GitIdentity { name: string; email: string }
export interface GitCredentialStatus { remotes: { name: string; url: string; push_url: string; configured: boolean }[]; hosts: string[] }
export interface GitCommit { hash: string; author: string; time: number; message: string; parents: string[] }
export interface GitMergeOperation { id: string; target: string; source: string; before: string; base: string; after: string; undone_by: string | null }
export interface GitRecoveryRequest { mode: 'undo_merge' | 'undo_commit' | 'restore_tree'; target: string; commit?: string; operation_id?: string; expected_head?: string }
export interface GitRecoveryPreview { head: string; files: string[]; changes: { path: string; added: string; deleted: string }[]; request: GitRecoveryRequest; strategy: string }
export interface GitDiff { path: string; old_path: string; base: string | null; target: string | null; patch: string; before: string; after: string; binary: boolean; truncated: boolean; submodule: boolean; snapshot?: string }
export interface BlameLine { line: number; hash: string; author: string; time: number; message: string }
export interface ScanJob { id: string; state: 'running' | 'complete' | 'failed' | 'superseded' | 'cancelled'; completed_projects: number; total_projects: number; error?: string }
export interface Comparison { ref?: string; commit?: string }
const query = (values: Record<string, string | number | undefined>) => '?' + new URLSearchParams(Object.entries(values).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))
const route = (id: string) => `/git/worktrees/${encodeURIComponent(id)}`
const post = (body?: unknown): RequestInit => ({ method: 'POST', body: body ? JSON.stringify(body) : undefined })
const del = (): RequestInit => ({ method: 'DELETE' })
export function createGitApi(client: typeof request = request) {
  return {
  taskWorkspace: (projectId: string, taskId: string) => client<TaskGitWorkspace>(`/git/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/workspace`),
  openTaskWorkspace: (projectId: string, taskId: string) => client<TaskGitWorkspace>(`/git/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/workspace`, post()),
  deleteTaskWorkspace: (projectId: string, taskId: string, force = false) => client<TaskGitWorkspaceDeletion>(`/git/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/workspace${force ? '?force=true' : ''}`, del()),
  addTaskWorktree: (projectId: string, taskId: string, repositoryId: string, alias: string, baseRef: string, branchName: string) => client<TaskGitWorkspace>(`/git/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/worktrees`, post({ repository_id: repositoryId, alias, base_ref: baseRef, branch_name: branchName })),
  removeTaskWorktree: (projectId: string, taskId: string, alias: string, force = false) => client<TaskGitWorkspace>(`/git/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}/worktrees/${encodeURIComponent(alias)}${force ? '?force=true' : ''}`, del()),
  scan: () => client<ScanJob>('/git/scans', post()),
  progress: (id: string) => client<ScanJob>(`/git/scans/${id}`),
  repositories: () => client<GitDiscovery>('/git/repositories'),
  initialize: (projectId: string) => client<{ project_id: string; path: string }>(`/git/projects/${encodeURIComponent(projectId)}/initialize`, post()),
  status: (id: string) => client<GitStatus>(route(id) + '/status'),
  branches: (id: string) => client<{ branches: GitBranch[]; remote_branches?: GitTrackedRemoteBranch[]; fetched_at?: number | null }>(route(id) + '/branches'),
  createBranch: (id: string, name: string, baseBranch: string, baseHead: string, snapshot: string, baseRemote?: string) => client<{ branches: GitBranch[]; remote_branches?: GitTrackedRemoteBranch[]; fetched_at?: number | null }>(route(id) + '/branches', post({ name, base_branch: baseBranch, base_head: baseHead, snapshot, base_remote: baseRemote })),
  deleteBranch: (id: string, branch: string, head: string, snapshot: string) => client<{ branches: GitBranch[]; remote_branches?: GitTrackedRemoteBranch[]; fetched_at?: number | null }>(route(id) + '/branches/delete', post({ branch, head, snapshot })),
  remotes: (id: string) => client<GitRemotes>(route(id) + '/remotes'),
  identity: (id: string) => client<GitIdentity>(route(id) + '/identity'),
  setIdentity: (id: string, identity: GitIdentity) => client<GitIdentity>(route(id) + '/identity', { method: 'PUT', body: JSON.stringify(identity) }),
  setGlobalIdentity: (id: string, identity: GitIdentity) => client<GitIdentity>(route(id) + '/identity/global', { method: 'PUT', body: JSON.stringify(identity) }),
  credentials: (id: string) => client<GitCredentialStatus>(route(id) + '/credentials'),
  saveHostCredentials: (host: string, username: string, token: string) => client<{ hosts: string[] }>('/git/credentials', { method: 'PUT', body: JSON.stringify({ host, username, token }) }),
  clearHostCredentials: (host: string) => client<{ hosts: string[] }>('/git/credentials/' + encodeURIComponent(host), { method: 'DELETE' }),
  saveCredentials: (id: string, remote: string, username: string, token: string) => client<GitCredentialStatus>(route(id) + '/credentials', { method: 'PUT', body: JSON.stringify({ remote, username, token }) }),
  clearCredentials: (id: string, remote: string) => client<GitCredentialStatus>(route(id) + '/credentials/' + encodeURIComponent(remote), { method: 'DELETE' }),
  history: (id: string, ref?: string, offset = 0) => client<{ commits: GitCommit[]; has_more: boolean }>(route(id) + '/history' + query({ ref, offset })),
  changes: (id: string, comparison: Comparison) => client<{ files: GitFile[] }>(route(id) + '/changes' + query({ ...comparison })),
  diff: (id: string, path: string, comparison: Comparison) => client<GitDiff>(route(id) + '/diff' + query({ path, ...comparison })),
  blame: (id: string, path: string, ref: string) => client<{ lines: BlameLine[] }>(route(id) + '/blame' + query({ path, ref })),
  commit: (id: string, paths: string[], message: string, snapshot: string) => client<{ head: string }>(route(id) + '/commit', post({ paths, message, snapshot })),
  discard: (id: string, path: string, snapshot: string) => client<GitStatus>(route(id) + '/discard', post({ path, snapshot })),
  ignore: (id: string, path: string, snapshot: string) => client<GitStatus>(route(id) + '/ignore', post({ path, snapshot })),
  saveFile: (id: string, path: string, content: string, snapshot: string, expectedContent?: string) => client<GitStatus>(route(id) + '/files/content', post({ path, content, snapshot, expected_content: expectedContent })),
  generateCommitMessage: (id: string, paths: string[], snapshot: string) => client<{ message: string }>(route(id) + '/commit-message', post({ paths, snapshot })),
  fetch: (id: string) => client<{ branches: GitBranch[]; remote_branches?: GitTrackedRemoteBranch[]; fetched_at?: number | null }>(route(id) + '/fetch', post()),
  fetchRemote: (id: string, remote: string) => client<GitRemotes>(route(id) + '/fetch-remote', post({ remote })),
  push: (id: string, branch: string, snapshot: string, target?: { remote: string; targetBranch: string; setUpstream: boolean }) => client<GitStatus>(route(id) + '/push', post({ branch, snapshot, remote: target?.remote, target_branch: target?.targetBranch, set_upstream: target?.setUpstream || false })),
  pull: (id: string, branch: string, snapshot: string, target?: { remote: string; targetBranch: string; setUpstream: boolean }) => client<GitStatus>(route(id) + '/pull', post({ branch, snapshot, remote: target?.remote, target_branch: target?.targetBranch, set_upstream: target?.setUpstream || false })),
  switch: (id: string, branch: string, snapshot: string, remote?: string) => client<GitStatus>(route(id) + '/switch', post({ branch, snapshot, remote })),
  advance: (id: string, branch: string, snapshot: string) => client<{ branches: GitBranch[]; remote_branches?: GitTrackedRemoteBranch[]; fetched_at?: number | null }>(route(id) + '/advance', post({ branch, snapshot })),
  merge: (id: string, branch: string, snapshot: string, source: string, remote?: string) => client<GitStatus>(route(id) + '/merge', post({ branch, snapshot, source, remote })),
  mergeInto: (id: string, branch: string, snapshot: string, target: string) => client<{ target: string; head: string; updated: boolean; push_available: boolean }>(route(id) + '/merge-into', post({ branch, snapshot, target })),
  recoveries: (id: string) => client<{ merges: GitMergeOperation[] }>(route(id) + '/recoveries'),
  recoveryPreview: (id: string, body: GitRecoveryRequest) => client<GitRecoveryPreview>(route(id) + '/recovery/preview', post(body)),
  recoveryApply: (id: string, body: GitRecoveryRequest) => client<{ target: string; head: string; files: string[]; push_available: boolean }>(route(id) + '/recovery/apply', post(body)),
  pushBranch: (id: string, branch: string, head: string, target?: { remote: string; targetBranch: string; setUpstream: boolean }) => client<{ branch: string; head: string }>(route(id) + '/push-branch', post({ branch, head, remote: target?.remote, target_branch: target?.targetBranch, set_upstream: target?.setUpstream || false })),
  }
}

export const gitApi = createGitApi()
export type GitApi = typeof gitApi
