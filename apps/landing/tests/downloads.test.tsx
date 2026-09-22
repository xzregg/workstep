import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PLATFORM_DOWNLOADS, REPOSITORY_URL, SOURCE_REPO_URL } from '../src/config/downloads'
import { Download } from '../src/components/Download'
import { I18nProvider } from '../src/i18n'

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
    expect(PLATFORM_DOWNLOADS.map(({ asset }) => asset)).toEqual([
      'WorkStep-macos-arm64.dmg',
      'WorkStep-macos-x64.dmg',
      'WorkStep-windows-x64.exe',
      'WorkStep-linux-x64.AppImage',
    ])
  })

  it('matches the stable artifact names emitted by electron-builder', () => {
    const desktopPackage = JSON.parse(
      readFileSync(resolve(import.meta.dirname, '../../desktop/package.json'), 'utf8'),
    )

    expect(desktopPackage.build.mac.artifactName).toBe('WorkStep-macos-${arch}.${ext}')
    expect(desktopPackage.build.win.artifactName).toBe('WorkStep-windows-${arch}.${ext}')
    expect(desktopPackage.build.linux.artifactName).toBe('WorkStep-linux-x64.${ext}')
  })

  it('shows a copyable GitHub clone command on the page', () => {
    const html = renderToStaticMarkup(
      <I18nProvider>
        <Download onOpen={() => undefined} />
      </I18nProvider>,
    )

    expect(html).toContain(`git clone ${SOURCE_REPO_URL}`)
    expect(html).not.toContain('git clone workstep\n')
  })
})
