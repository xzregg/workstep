import { createContext, useContext } from 'react'
import { gitApi, type GitApi } from '../../api/git'

export const GitApiContext = createContext<{ api: GitApi; shared: boolean; readOnly: boolean }>({ api: gitApi, shared: false, readOnly: false })
export const useGitApi = () => useContext(GitApiContext).api
export const useSharedGit = () => useContext(GitApiContext).shared
export const useReadOnlyGit = () => useContext(GitApiContext).readOnly
