const fs = require('node:fs/promises')
const path = require('node:path')
const { shouldOfferUpdate } = require('./update-version.cjs')

const RELEASE_API_URL = 'https://api.github.com/repos/xzregg/workstep/releases/latest'
const RELEASES_URL = 'https://github.com/xzregg/workstep/releases/latest'
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

function normalizeVersion(value) {
  return String(value || '').trim().replace(/^v/i, '')
}

function safeReleaseUrl(value) {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' && url.hostname === 'github.com'
      && url.pathname.startsWith('/xzregg/workstep/releases/')) return url.toString()
  } catch {}
  return RELEASES_URL
}

function releaseStatus(currentVersion, release, checkedAt) {
  const latestVersion = normalizeVersion(release?.tag_name)
  return {
    currentVersion: normalizeVersion(currentVersion),
    latestVersion,
    updateAvailable: shouldOfferUpdate(currentVersion, latestVersion),
    releaseUrl: safeReleaseUrl(release?.html_url),
    checkedAt,
  }
}

function validCache(value) {
  return value && Number.isFinite(value.checkedAt) && typeof value.currentVersion === 'string'
    && typeof value.latestVersion === 'string' && typeof value.updateAvailable === 'boolean'
    && typeof value.releaseUrl === 'string'
}

function createUpdateChecker({ currentVersion, now = Date.now, readCache, writeCache, fetchRelease,
  readPreferences = async () => ({}), writePreferences = async () => {},
}) {
  return {
    async check({ force = false, cachedOnly = false } = {}) {
      const checkedAt = now()
      const preferences = await readPreferences().catch(() => ({}))
      const automaticCheckEnabled = preferences?.automaticCheckEnabled !== false
      const cached = await readCache().catch(() => null)
      const usableCache = validCache(cached) && cached.currentVersion === normalizeVersion(currentVersion)
      if (cachedOnly || (!force && !automaticCheckEnabled)) {
        return { ...(usableCache ? cached : releaseStatus(currentVersion, null, 0)), source: 'cache', automaticCheckEnabled }
      }
      if (!force && usableCache && checkedAt - cached.checkedAt < CHECK_INTERVAL_MS) {
        return { ...cached, source: 'cache', automaticCheckEnabled }
      }
      const status = releaseStatus(currentVersion, await fetchRelease(), checkedAt)
      await writeCache(status).catch(() => undefined)
      return { ...status, source: 'network', automaticCheckEnabled }
    },
    async setAutomaticCheckEnabled(enabled) {
      if (typeof enabled !== 'boolean') throw new TypeError('Expected a boolean update preference')
      await writePreferences({ automaticCheckEnabled: enabled })
      return this.check({ cachedOnly: true })
    },
  }
}

function createDesktopUpdateService(app, fetchImpl = fetch) {
  const cacheFile = path.join(app.getPath('userData'), 'desktop-update.json')
  const preferencesFile = path.join(app.getPath('userData'), 'desktop-update-preferences.json')
  return createUpdateChecker({
    currentVersion: app.getVersion(),
    readPreferences: async () => JSON.parse(await fs.readFile(preferencesFile, 'utf8')),
    writePreferences: async value => fs.writeFile(preferencesFile, `${JSON.stringify(value, null, 2)}\n`, 'utf8'),
    readCache: async () => JSON.parse(await fs.readFile(cacheFile, 'utf8')),
    writeCache: async value => fs.writeFile(cacheFile, `${JSON.stringify(value, null, 2)}\n`, 'utf8'),
    fetchRelease: async () => {
      const response = await fetchImpl(RELEASE_API_URL, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `WorkStep/${app.getVersion()}` },
        signal: AbortSignal.timeout(15_000),
      })
      if (!response.ok) throw new Error(`GitHub release check failed (${response.status})`)
      return response.json()
    },
  })
}

module.exports = { CHECK_INTERVAL_MS, RELEASE_API_URL, RELEASES_URL, createDesktopUpdateService, createUpdateChecker, releaseStatus, safeReleaseUrl }
