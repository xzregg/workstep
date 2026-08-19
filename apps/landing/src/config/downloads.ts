export interface PlatformDownload {
  key: 'macos' | 'windows' | 'linux'
  url?: string
}

export const PLATFORM_DOWNLOADS: PlatformDownload[] = [
  { key: 'macos' },
  { key: 'windows' },
  { key: 'linux' },
]

export const SOURCE_REPO_URL = 'https://gitlab.base.packertec.com/zhaorong.xie/workstep.git'
export const SOURCE_START_COMMAND = './start.sh'
