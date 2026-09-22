const EXTERNAL_SCHEME = /^[a-z][a-z\d+.-]*:/i
const WINDOWS_ABSOLUTE_PATH = /^[a-z]:[\\/]/i
/** A `file://` URL pointing at a real file, e.g. file:///Users/me/proj/index.html. */
const FILE_URL = /^file:\/\//i

/**
 * Reduce a `file://` URL to a filesystem path the preview API can resolve.
 * macOS/Linux keep their leading slash; Windows `/C:/Users/...` becomes
 * `C:/Users/...` so pathlib treats it as an absolute drive path.
 */
function fileUrlToPath(href: string): string {
  let path = href.replace(/^file:\/\//i, '')
  if (path.startsWith('localhost/')) path = path.slice('localhost'.length)
  path = path.replace(/^\/([a-z]:)/i, '$1')
  return path
}

export interface ProjectFileLink {
  path: string
  name: string
  line?: number
  column?: number
}

function splitSourceLocation(path: string): { path: string; line?: number; column?: number } {
  const match = path.match(/^(.*)#L(\d+)(?:C(\d+))?$/i)
    || path.match(/^(.*?):(\d+)(?::(\d+))?$/)
  if (!match || !match[1]) return { path }
  return {
    path: match[1],
    line: Number(match[2]),
    column: match[3] ? Number(match[3]) : undefined,
  }
}

export function classifyProjectFileLink(
  href: string | undefined,
  projectId: string | undefined,
): ProjectFileLink | null {
  if (!href || !projectId || href.startsWith('#') || href.startsWith('//')) return null

  // `file://` URLs point at a real file: strip the scheme so the (absolute)
  // path is handed to the preview API, which resolves it and enforces the
  // project-boundary check server-side. Other external schemes (http,
  // mailto, ...) still fall through to a plain link.
  let candidate = href
  if (FILE_URL.test(href)) {
    candidate = fileUrlToPath(href)
  } else if (EXTERNAL_SCHEME.test(href) && !WINDOWS_ABSOLUTE_PATH.test(href)) {
    return null
  }

  const sourceLocation = splitSourceLocation(candidate)
  const path = sourceLocation.path.split(/[?#]/, 1)[0]
  if (!path || path.endsWith('/')) return null
  let decoded = path
  try {
    decoded = decodeURIComponent(path)
  } catch {
    // Keep the original path; the API will report an invalid or missing file.
  }
  const name = decoded.replace(/\\/g, '/').split('/').filter(Boolean).at(-1)
  if (!name) return null
  return {
    path: decoded,
    name,
    ...(sourceLocation.line ? { line: sourceLocation.line } : {}),
    ...(sourceLocation.column ? { column: sourceLocation.column } : {}),
  }
}
