const EXTERNAL_SCHEME = /^[a-z][a-z\d+.-]*:/i
const WINDOWS_ABSOLUTE_PATH = /^[a-z]:[\\/]/i

export interface ProjectFileLink {
  path: string
  name: string
}

export function classifyProjectFileLink(
  href: string | undefined,
  projectId: string | undefined,
): ProjectFileLink | null {
  if (!href || !projectId || href.startsWith('#') || href.startsWith('//')) return null
  if (EXTERNAL_SCHEME.test(href) && !WINDOWS_ABSOLUTE_PATH.test(href)) return null

  const path = href.split(/[?#]/, 1)[0]
  if (!path || path.endsWith('/')) return null
  let decoded = path
  try {
    decoded = decodeURIComponent(path)
  } catch {
    // Keep the original path; the API will report an invalid or missing file.
  }
  const name = decoded.replace(/\\/g, '/').split('/').filter(Boolean).at(-1)
  return name ? { path: decoded, name } : null
}
