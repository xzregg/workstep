function managedSessionExpired(details, rootUrl) {
  if (details.statusCode !== 401 || !rootUrl) return false
  let url
  try { url = new URL(details.url) } catch { return false }
  if (url.origin !== new URL(rootUrl).origin || !url.pathname.startsWith('/api/')
      || url.pathname === '/api/managed/bootstrap') return false
  return Object.entries(details.responseHeaders ?? {}).some(([key, values]) =>
    key.toLowerCase() === 'x-workstep-managed-session-expired'
      && Array.isArray(values) && values.includes('1'))
}

module.exports = { managedSessionExpired }
