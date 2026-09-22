interface ArtifactPathEntry {
  step_key: string
  round: number
  path?: string
  is_dir?: boolean
}

function normalizedArtifactPath(path: string) {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

export function collapseDirectoryArtifactChildren<T extends ArtifactPathEntry>(
  artifacts: readonly T[],
): T[] {
  const directories = artifacts
    .filter((artifact) => artifact.is_dir && artifact.path)
    .map((artifact) => ({
      stepKey: artifact.step_key,
      round: artifact.round,
      path: normalizedArtifactPath(artifact.path!),
    }))

  if (!directories.length) return [...artifacts]

  return artifacts.filter((artifact) => {
    if (!artifact.path) return true
    const path = normalizedArtifactPath(artifact.path)
    return !directories.some((directory) => (
      directory.stepKey === artifact.step_key
      && directory.round === artifact.round
      && path.startsWith(`${directory.path}/`)
    ))
  })
}
