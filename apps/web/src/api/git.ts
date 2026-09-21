import { request } from './client'

export interface GitFile { path: string; old_path: string | null; index_status: string; worktree_status: string; untracked: boolean; staged: boolean; conflict: boolean; submodule: boolean }
export interface GitWorktree { id: string; path: string; branch: string | null; head: string; main: boolean; available: boolean; locked: boolean; prunable: boolean }
export interface GitRepository { id: string; name: string; common_dir: string; worktrees: GitWorktree[]; projects: { id: string; relative_path: string }[] }
export interface GitDiscovery { projects: { id: string; name: string; path: string }[]; repositories: GitRepository[]; depth: number; scanned_at: number | null; errors: { path: string; message: string }[] }
export interface GitStatus { id: string; path: string; head: string | null; branch: string | null; files: GitFile[]; snapshot: string; operation: string | null; active: boolean; ahead: number | null; behind: number | null; upstream: string | null }
export interface GitBranch { upstream?: string | null; upstream_gone?: boolean; remote?: string | null; ahead?: number | null; behind?: number | null; name: string; head: string; worktree_id: string | null; path: string | null }
export interface GitCommit { hash: string; author: string; time: number; message: string }
export interface GitDiff { path: string; old_path: string; base: string | null; target: string | null; patch: string; before: string; after: string; binary: boolean; truncated: boolean; submodule: boolean; snapshot?: string }
export interface BlameLine { line: number; hash: string; author: string; time: number; message: string }
export interface ScanJob { id: string; state: 'running' | 'complete' | 'failed' | 'superseded' | 'cancelled'; completed_projects: number; total_projects: number; error?: string }
export interface Comparison { ref?: string; commit?: string }
const query = (values: Record<string, string | number | undefined>) => '?' + new URLSearchParams(Object.entries(values).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))
const route = (id: string) => `/git/worktrees/${encodeURIComponent(id)}`
const post = (body?: unknown): RequestInit => ({ method: 'POST', body: body ? JSON.stringify(body) : undefined })
export const gitApi = {
  scan: () => request<ScanJob>('/git/scans', post()),
  progress: (id: string) => request<ScanJob>(`/git/scans/${id}`),
  repositories: () => request<GitDiscovery>('/git/repositories'),
  status: (id: string) => request<GitStatus>(route(id) + '/status'),
  branches: (id: string) => request<{ branches: GitBranch[]; fetched_at?: number | null }>(route(id) + '/branches'),
  history: (id: string, ref?: string, offset = 0) => request<{ commits: GitCommit[]; has_more: boolean }>(route(id) + '/history' + query({ ref, offset })),
  changes: (id: string, comparison: Comparison) => request<{ files: GitFile[] }>(route(id) + '/changes' + query({ ...comparison })),
  diff: (id: string, path: string, comparison: Comparison) => request<GitDiff>(route(id) + '/diff' + query({ path, ...comparison })),
  blame: (id: string, path: string, ref: string) => request<{ lines: BlameLine[] }>(route(id) + '/blame' + query({ path, ref })),
  commit: (id: string, paths: string[], message: string, snapshot: string) => request<{ head: string }>(route(id) + '/commit', post({ paths, message, snapshot })),
  discard: (id: string, path: string, snapshot: string) => request<GitStatus>(route(id) + '/discard', post({ path, snapshot })),
  ignore: (id: string, path: string, snapshot: string) => request<GitStatus>(route(id) + '/ignore', post({ path, snapshot })),
  saveFile: (id: string, path: string, content: string, snapshot: string) => request<GitStatus>(route(id) + '/files/content', post({ path, content, snapshot })),
  generateCommitMessage: (id: string, paths: string[], snapshot: string) => request<{ message: string }>(route(id) + '/commit-message', post({ paths, snapshot })),
  fetch: (id: string) => request<{ branches: GitBranch[]; fetched_at?: number | null }>(route(id) + '/fetch', post()),
  push: (id: string, branch: string, snapshot: string) => request<GitStatus>(route(id) + '/push', post({ branch, snapshot })),
  pull: (id: string, branch: string, snapshot: string) => request<GitStatus>(route(id) + '/pull', post({ branch, snapshot })),
  switch: (id: string, branch: string, snapshot: string) => request<GitStatus>(route(id) + '/switch', post({ branch, snapshot })),
}
