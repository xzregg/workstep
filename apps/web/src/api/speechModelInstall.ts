export interface VoiceModelInstall {
  stage: string
  downloaded_bytes: number
  total_bytes: number | null
  error: string
  partial_bytes?: number
}

export const modelDownloading = (install: VoiceModelInstall) =>
  ['resolving', 'downloading', 'installing'].includes(install.stage)
