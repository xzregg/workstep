export interface SandboxSettings {
  enabled: boolean
  root: string
  project: string
  mounts: { source: string; target: string }[]
  prepared?: boolean
  compatibility?: boolean
  dockerImage?: string | null
}
export interface LocalDockerImage { id: string; tags: string[]; size: number }
export interface SandboxStatus {
  settings: SandboxSettings
  phase: string
  progress: { received: number; total: number | null } | null
  error: string | null
  running: boolean
  supported: boolean
  onlineImage?: boolean
}
export interface SandboxBridge {
  status(): Promise<SandboxStatus>
  dockerImages(): Promise<{ images: LocalDockerImage[]; error: string | null }>
  chooseDirectory(): Promise<string | null>
  prepare(settings: SandboxSettings): Promise<SandboxStatus>
  switchMode(enabled: boolean): Promise<void>
  importConfig(kind: 'codex' | 'claude' | 'agents'): Promise<SandboxStatus>
  remove(): Promise<SandboxStatus>
  logs(): Promise<void>
}
