// Shared by Electron and the web bundle. Never serialize configuration, headers
// or request bodies before calling this function: collection is allowlisted too.
const ROUTES = new Set(('api project projects task tasks chat-sessions messages events system-settings providers provider engines engine assistant assistants templates list status history settings task-share public health chat workflows workflow statistics schedule schedules artifacts git remote-project files channels concurrency roles share assets').split(' '))

export function diagnosticRoute(value) {
  let path = String(value).split(/[?#]/, 1)[0]
  try { if (/^https?:\/\//i.test(path)) path = new URL(path).pathname } catch { return '/:id' }
  return '/' + path.split('/').filter(Boolean).map(segment => ROUTES.has(segment) ? segment : ':id').join('/')
}

export function redactDiagnosticText(value, { secrets = [], identities = [], homeDirectory = '' } = {}) {
  let text = String(value)
  for (const secret of [...secrets, ...identities].filter(value => typeof value === 'string' && value).sort((a, b) => b.length - a.length)) {
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, 'gu')
    text = text.split(/(\[(?:redacted(?: authorization| private key)?|url|path|email|address|id)\])/g)
      .map(part => /^\[(?:redacted(?: authorization| private key)?|url|path|email|address|id)\]$/.test(part)
        ? part : secret.length < 3 ? part.replace(pattern, '$1[redacted]') : part.replaceAll(secret, '[redacted]')).join('')
  }
  if (homeDirectory) text = text.replaceAll(homeDirectory, '~')
  return text
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[redacted private key]')
    .replace(/(^|\n)(\s*(?:cookie|set-cookie|authorization|proxy-authorization)\s*:\s*)[^\r\n]*/gi, '$1$2[redacted]')
    .replace(/((?:["']?)(?:authorization|proxy-authorization|cookie|set-cookie|api[_-]?key|password|passwd|pwd|secret|credential|session|auth_code|authorization_code|state|nonce|signature|path|file_path|directory|[\w-]*token|user[_-]?name|account|email|device[_-]?name|project(?:[_-]?(?:name|id))?|session[_-]?id|task[_-]?id|用户名|账号|邮箱|项目名称|项目|设备名称)["']?\s*[:=：]\s*)(?:\[redacted\]|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n,}]+)/gi, '$1[redacted]')
    .replace(/\b(?:Bearer|Basic)\s+[\w+/=.-]+/gi, '[redacted authorization]')
    .replace(/\b(?:sk-(?:proj-|ant-)?[\w-]{16,}|gh[pousr]_[\w]{20,}|github_pat_[\w]{20,}|AKIA[A-Z0-9]{16}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, '[redacted]')
    .replace(/https?:\/\/[^\s<>"']+/gi, value => {
      return '[url]' + (/:(\d+)(?::\d+)?\)?$/.exec(value)?.[0] || '')
    })
    .replace(/(?:\b[a-z]:[\\/]|\\\\[^\\\s]+\\|\/(?:Users|home|root|Volumes|tmp|private|var|workspace|workspaces|projects|data|storage|media|run|proc|sys|mnt|opt|srv|etc)\/|~\/)[^\r\n"'<>]*/gi, value => {
      const location = /:\d+(?::\d+)?\)?$/.exec(value)?.[0] || ''
      return `[path]${location}`
    })
    .replace(/(["'])\/[^"'\r\n]*\1/g, '[path]')
    .replace(/(^|[\s("'=])\/[^\s"'<>)]*/gm, (_match, prefix) => `${prefix}[path]`)
    .replace(/\b(?:[\w-]+\.)+(?:local|internal|lan|localhost)\b/gi, '[host]')
    .replace(/\b[\w.!#$%&'*+/=?^`{|}~-]+@[\w.-]+\.[a-z]{2,}\b/gi, '[email]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[address]')
    .replace(/\b(?:f[cd][\da-f]{2}|fe[89ab][\da-f])(?::[\da-f]{0,4}){1,7}(?:%[\w.-]+)?/gi, '[address]')
    .replace(/::1\b/g, '[address]')
    .replace(/\b(?:[\da-f]{32,}|[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12})\b/gi, '[id]')
}
