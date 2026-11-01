const { shouldOfferUpdate } = require('./update-version.cjs')

function createAutoUpdateController({ updater, currentVersion, beforeInstall, install = () => updater.quitAndInstall(true, true) }) {
  let state = { phase: 'idle', percent: 0, error: null }
  let pending = null
  updater.autoDownload = false
  updater.autoInstallOnAppQuit = false
  updater.on('download-progress', ({ percent }) => {
    state = { phase: 'downloading', percent: Math.max(0, Math.min(100, Math.round(percent || 0))), error: null }
  })
  // electron-updater emits errors as well as rejecting its operation promise.
  updater.on('error', error => { state = { ...state, phase: 'error', error: error.message } })
  return {
    status: () => ({ ...state }),
    start() {
      if (pending) return pending
      if (state.phase === 'installing') return Promise.resolve()
      state = { phase: 'checking', percent: 0, error: null }
      pending = (async () => {
        const result = await updater.checkForUpdates()
        if (!result || !shouldOfferUpdate(currentVersion, result.updateInfo.version)) {
          state = { phase: 'idle', percent: 0, error: null }
          return
        }
        state = { phase: 'downloading', percent: 0, error: null }
        await updater.downloadUpdate()
        state = { phase: 'installing', percent: 100, error: null }
        await beforeInstall()
        install()
      })().catch(error => {
        state = { ...state, phase: 'error', error: error.message }
        throw error
      }).finally(() => { pending = null })
      return pending
    },
  }
}

module.exports = { createAutoUpdateController }
