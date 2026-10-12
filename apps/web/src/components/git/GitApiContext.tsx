import { createContext, useContext } from 'react'
import { gitApi, type GitApi } from '../../api/git'
import { fsApi, type DirectoryBrowseResult } from '../../api/client'

export type GitWorkspaceBrowser = (path: string, includeHidden: boolean) => Promise<DirectoryBrowseResult>
export const GitApiContext = createContext<{ api: GitApi; shared: boolean; projectScoped?: boolean; readOnly: boolean; workspaceEditable?: boolean; allowedActions?: readonly string[]; permissionCheck?: (permission: string) => boolean; browseWorkspace: GitWorkspaceBrowser }>({
  api: gitApi, shared: false, readOnly: false,
  browseWorkspace: (path, includeHidden) => fsApi.browse(path, undefined, includeHidden),
})
export const useGitApi = () => useContext(GitApiContext).api
export const useSharedGit = () => useContext(GitApiContext).shared
export const useProjectScopedGit = () => !!useContext(GitApiContext).projectScoped
export const useReadOnlyGit = () => useContext(GitApiContext).readOnly
export const useGitWorkspaceBrowser = () => useContext(GitApiContext).browseWorkspace

export const useGitWorkspaceEditable = () => useContext(GitApiContext).workspaceEditable !== false

export const useGitActionAllowed = () => {
  const { readOnly, allowedActions, permissionCheck } = useContext(GitApiContext)
  return (action: string) => {
    const permission = ['fetch', 'fetchRemote', 'pull', 'push', 'pushBranch', 'advance'].includes(action) ? 'git.remote'
      : action === 'saveFile' ? 'file.edit' : action === 'deleteWorktree' ? 'git.workspace' : action === 'config' ? 'git.config' : 'git.write'
    return !readOnly && (!allowedActions || allowedActions.includes(action)) && (!permissionCheck || permissionCheck(permission))
  }
}
