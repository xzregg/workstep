/* Grant audio capture only to the trusted WorkStep top-level application. */
function sameOrigin(value, expected) {
  try { return new URL(value).origin === new URL(expected).origin } catch { return false }
}

function audioRequestAllowed(contents, permission, details, rootUrl) {
  return permission === 'media' && !!contents && !contents.isDestroyed()
    && sameOrigin(contents.getURL(), rootUrl)
    && sameOrigin(details.requestingUrl || details.securityOrigin || '', rootUrl)
    && details.isMainFrame !== false
    && Array.isArray(details.mediaTypes) && details.mediaTypes.length > 0
    && details.mediaTypes.every(type => type === 'audio')
}

function configureSpeechPermissions(session, rootUrl, { systemPreferences, platform = process.platform } = {}) {
  const systemStatus = () => {
    if (platform !== 'darwin' && platform !== 'win32') return 'granted'
    try { return systemPreferences?.getMediaAccessStatus('microphone') || 'unknown' }
    catch { return 'unknown' }
  }
  const permittedStatus = status => platform === 'darwin'
    ? status === 'granted' : !['denied', 'restricted'].includes(status)
  // Share one native prompt across simultaneous first-use requests.
  let pendingConsent = null
  session.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    details = details || {}
    if (!audioRequestAllowed(contents, permission, details, rootUrl)) { callback(false); return }
    const page = contents.getURL()
    let allowed = false
    try {
      const status = systemStatus()
      allowed = permittedStatus(status)
      if (platform === 'darwin' && status === 'not-determined') {
        if (!pendingConsent) {
          pendingConsent = Promise.resolve().then(() => systemPreferences.askForMediaAccess('microphone'))
            .finally(() => { pendingConsent = null })
        }
        allowed = await pendingConsent
      }
    } catch { allowed = false }
    callback(Boolean(allowed && audioRequestAllowed(contents, permission, details, rootUrl) && contents.getURL() === page))
  })
  session.setPermissionCheckHandler?.((contents, permission, origin, details) => {
    return permission === 'media' && !!contents && !contents.isDestroyed()
      && sameOrigin(contents.getURL(), rootUrl) && sameOrigin(origin, rootUrl)
      && details?.mediaType === 'audio' && details?.isMainFrame !== false
      && permittedStatus(systemStatus())
  })
}
module.exports = { audioRequestAllowed, configureSpeechPermissions }
