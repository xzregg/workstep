/* Grant capture only to the trusted WorkStep top-level application. */
function sameOrigin(value, expected) {
  try { return new URL(value).origin === new URL(expected).origin } catch { return false }
}
function mediaRequestAllowed(contents, permission, details, rootUrl) {
  return permission === 'media' && !!contents && !contents.isDestroyed()
    && sameOrigin(contents.getURL(), rootUrl)
    && sameOrigin(details.requestingUrl || details.securityOrigin || '', rootUrl)
    && details.isMainFrame !== false
    && Array.isArray(details.mediaTypes) && details.mediaTypes.length > 0
    && details.mediaTypes.every(type => type === 'audio' || type === 'video')
}
function audioRequestAllowed(contents, permission, details, rootUrl) {
  return mediaRequestAllowed(contents, permission, details, rootUrl) && details.mediaTypes.every(type => type === 'audio')
}
function configureSpeechPermissions(session, rootUrl, { systemPreferences, platform = process.platform } = {}) {
  const systemStatus = type => {
    if (platform !== 'darwin' && platform !== 'win32') return 'granted'
    try { return systemPreferences?.getMediaAccessStatus(type) || 'unknown' }
    catch { return 'unknown' }
  }
  const permittedStatus = status => platform === 'darwin'
    ? status === 'granted' : !['denied', 'restricted'].includes(status)
  const pendingConsent = new Map()
  session.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    details = details || {}
    if (!mediaRequestAllowed(contents, permission, details, rootUrl)) { callback(false); return }
    const page = contents.getURL()
    let allowed = true
    try {
      for (const mediaType of new Set(details.mediaTypes)) {
        const type = mediaType === 'video' ? 'camera' : 'microphone'
        const status = systemStatus(type)
        let granted = permittedStatus(status)
        if (platform === 'darwin' && status === 'not-determined') {
          if (!pendingConsent.has(type)) {
            pendingConsent.set(type, Promise.resolve().then(() => systemPreferences.askForMediaAccess(type))
              .finally(() => pendingConsent.delete(type)))
          }
          granted = await pendingConsent.get(type)
        }
        if (!granted) { allowed = false; break }
      }
    } catch { allowed = false }
    callback(Boolean(allowed && mediaRequestAllowed(contents, permission, details, rootUrl) && contents.getURL() === page))
  })
  session.setPermissionCheckHandler?.((contents, permission, origin, details) => {
    return permission === 'media' && !!contents && !contents.isDestroyed()
      && sameOrigin(contents.getURL(), rootUrl) && sameOrigin(origin, rootUrl)
      && ['audio', 'video'].includes(details?.mediaType) && details?.isMainFrame !== false
      && permittedStatus(systemStatus(details.mediaType === 'video' ? 'camera' : 'microphone'))
  })
}
module.exports = { audioRequestAllowed, mediaRequestAllowed, configureSpeechPermissions }
