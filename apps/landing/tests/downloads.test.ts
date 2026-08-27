import { describe, expect, it } from 'vitest'
import { PLATFORM_DOWNLOADS, REPOSITORY_URL, SOURCE_REPO_URL } from '../src/config/downloads'

describe('public download configuration', () => {
  it('uses the public GitHub repository and four desktop artifacts', () => {
    expect(REPOSITORY_URL).toBe('https://github.com/xzregg/workstep')
    expect(SOURCE_REPO_URL).toBe('https://github.com/xzregg/workstep.git')
    expect(PLATFORM_DOWNLOADS.map(({ key, arch }) => `${key}-${arch}`)).toEqual([
      'macos-arm64',
      'macos-x64',
      'windows-x64',
      'linux-x64',
    ])
    expect(PLATFORM_DOWNLOADS.every(({ url }) => url.includes('/releases/latest/download/'))).toBe(true)
  })
})
