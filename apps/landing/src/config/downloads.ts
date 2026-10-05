export interface PlatformDownload {
  key: 'macos' | 'windows' | 'linux'
  arch: 'arm64' | 'x64'
  asset: string
  url: string
}

export const REPOSITORY_URL = 'https://github.com/xzregg/workstep'
export const RELEASES_URL = `${REPOSITORY_URL}/releases/latest`
const RELEASE_DOWNLOAD_URL = `${REPOSITORY_URL}/releases/latest/download`

export const PLATFORM_DOWNLOADS: PlatformDownload[] = [
  { key: 'macos', arch: 'arm64', asset: 'WorkStep-macos-arm64.dmg', url: `${RELEASE_DOWNLOAD_URL}/WorkStep-macos-arm64.dmg` },
  { key: 'macos', arch: 'x64', asset: 'WorkStep-macos-x64.dmg', url: `${RELEASE_DOWNLOAD_URL}/WorkStep-macos-x64.dmg` },
  { key: 'windows', arch: 'x64', asset: 'WorkStep-windows-x64.exe', url: `${RELEASE_DOWNLOAD_URL}/WorkStep-windows-x64.exe` },
  { key: 'linux', arch: 'x64', asset: 'WorkStep-linux-x64.AppImage', url: `${RELEASE_DOWNLOAD_URL}/WorkStep-linux-x64.AppImage` },
]

export const SOURCE_REPO_URL = `${REPOSITORY_URL}.git`
export const SOURCE_START_COMMAND = './start.sh'
