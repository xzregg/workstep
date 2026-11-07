export interface SandboxSettings {
  enabled: boolean
  root: string
  project: string
  mounts: { source: string; target: string }[]
  prepared?: boolean
  compatibility?: boolean
  dockerImage?: string | null
  registeredProjects?: string[]
  migrationWarnings?: string[]
}
export interface HostSandboxProject { path: string; name: string; id?: string }
export type SandboxConfigImport = 'codex' | 'claude' | 'agents' | { source: string }
export interface SandboxMigrationOptions { providers: boolean; engines: boolean; preferences: boolean; overwrite?: boolean }
export interface LocalDockerImage { id: string; tags: string[]; size: number }
export interface SandboxStatus {
  configSyncVersion?: number
  settings: SandboxSettings
  phase: string
  progress: { received: number; total: number | null } | null
  error: string | null
  running: boolean
  health?: 'stopped' | 'starting' | 'healthy' | 'failed'
  hostPort?: number | null
  logDirectory?: string | null
  supported: boolean
  onlineImage?: boolean
  platform?: string
  arch?: string
  runtimeReady?: boolean
  imageReady?: boolean
  cachedDockerImage?: string | null
}
export interface SandboxBridge {
  status(): Promise<SandboxStatus>
  dockerImages(): Promise<{ images: LocalDockerImage[]; error: string | null }>
  hostProjects(): Promise<HostSandboxProject[]>
  prepareRuntime(input: { root: string }): Promise<SandboxStatus>
  prepareImage(input: { root: string; dockerImage?: string | null }): Promise<SandboxStatus>
  chooseDirectory(): Promise<string | null>
  chooseConfigDirectory?(): Promise<{ source: string; name: string } | null>
  prepare(settings: SandboxSettings): Promise<SandboxStatus>
  switchMode(enabled: boolean): Promise<void>
  switchImage(image: string): Promise<void>
  importConfig(input: SandboxConfigImport): Promise<SandboxStatus>
  migrateSettings(options: SandboxMigrationOptions): Promise<SandboxStatus>
  remove(): Promise<SandboxStatus>
  logs(): Promise<void>
  readLogs(): Promise<string>
  copyLogs(): Promise<void>
}
