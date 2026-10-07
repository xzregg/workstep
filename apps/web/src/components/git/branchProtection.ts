export const isProtectedGitBranch = (branch: string | null) => !!branch && ['main', 'master', 'develop', 'development', 'trunk'].includes(branch)
