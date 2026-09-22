function parseUrl(value) {
  try {
    return new URL(value)
  } catch {
    return null
  }
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

function updaterChannel(platform, arch) {
  if (platform !== 'darwin' && platform !== 'win32') return null
  return `latest-${arch}`
}

module.exports = {
  isAllowedExternalUrl,
  isTrustedNavigation,
  projectsHaveActiveWork,
  sessionsHaveActiveWork,
  updaterChannel,
}
