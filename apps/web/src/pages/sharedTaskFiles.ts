import type { TaskArtifact } from '../api/client'

export function sharedTaskArtifactFiles(artifacts: TaskArtifact[]): TaskArtifact[] {
  return artifacts.map(artifact => artifact.source_path && !artifact.is_dir
    ? { ...artifact, path: `.workstep/artifacts/${artifact.source_path}` } : artifact)
}

/** Resolve recorded file paths using only the current share's authorized artifacts. */
export function sharedTaskFilePath(path: string, artifacts: TaskArtifact[]): string {
  const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '')
  const artifact = artifacts.find(item => item.source_path && (
    normalized === item.source_path
    || normalized === `.workstep/artifacts/${item.source_path}`
    || normalized.endsWith(`/artifacts/${item.source_path}`)
  ))
  return artifact?.path || path
}
