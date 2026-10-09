const { validateGatewayOrigin } = require('./gateway-origin.cjs')

function parseUrl(value) {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function isGatewayDesktopLoginUrl(value) {
  const target = parseUrl(value)
  if (!target || target.pathname !== '/desktop/login' || target.hash) return false
  try { validateGatewayOrigin(target.origin) } catch { return false }
  const required = ['gateway_id', 'app_instance_id', 'state', 'nonce', 'code_challenge']
  const redirect = target.searchParams.get('redirect_uri')
  if (redirect) {
    const callback = parseUrl(redirect)
    const loopback = callback && (callback.hostname === 'localhost' || callback.hostname === '127.0.0.1'
      || callback.hostname === '[::1]')
    if (!loopback || !['http:', 'https:'].includes(callback.protocol)
        || callback.pathname !== '/api/gateway-platform/callback' || callback.username
        || callback.password || callback.search || callback.hash) return false
  }
  const allowedCount = required.length + (redirect ? 1 : 0)
  return [...target.searchParams].length === allowedCount
    && (!redirect || target.searchParams.getAll('redirect_uri').length === 1)
    && required.every(key => target.searchParams.getAll(key).length === 1 && target.searchParams.get(key))
}

function isTrustedNavigation(value, rootUrl) {
  const target = parseUrl(value)
  const root = parseUrl(rootUrl)
  return Boolean(target && root && target.origin === root.origin)
}

function isAllowedExternalUrl(value) {
  const target = parseUrl(value)
  return Boolean(target && (target.protocol === 'https:' || target.protocol === 'http:'))
}

function projectsHaveActiveWork(payload) {
  if (!payload || !Array.isArray(payload.projects)) return true
  return payload.projects.some((project) => (
    project?.has_running_tasks === true
    || (Array.isArray(project?.workflows)
      && project.workflows.some((workflow) => workflow?.running === true))
  ))
}

function sessionsHaveActiveWork(payload) {
  if (!payload || !Array.isArray(payload.sessions)) return true
  return payload.sessions.some((session) => session?.running === true)
}

function primaryNetworkIPv4(interfaces = require('node:os').networkInterfaces()) {
  const candidates = Object.values(interfaces).flat().filter((item) => (
    item && (item.family === 'IPv4' || item.family === 4) && !item.internal
    && !item.address.startsWith('127.') && !item.address.startsWith('169.254.')
    && !item.address.startsWith('198.18.') && !item.address.startsWith('198.19.')
  ))
  const rank = (address) => (
    address.startsWith('10.') || address.startsWith('192.168.')
      || /^172\.(1[6-9]|2\d|3[01])\./.test(address) ? 0 : 1
  )
  candidates.sort((left, right) => rank(left.address) - rank(right.address))
  return candidates[0]?.address || '127.0.0.1'
}

module.exports = {
  isAllowedExternalUrl,
  isGatewayDesktopLoginUrl,
  isTrustedNavigation,
  projectsHaveActiveWork,
  sessionsHaveActiveWork,
  primaryNetworkIPv4,
}
