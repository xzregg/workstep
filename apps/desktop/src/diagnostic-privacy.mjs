// Shared by Electron and the web bundle. Never serialize configuration, headers
// or request bodies before calling this function: collection is allowlisted too.
const ROUTES = new Set(('access action action-runs actions activity add advance affect api appearance apply approve archive archive-experience artifacts assets assistant assistants atlas audio available balance batch binary-path bind-task blame bootstrap branches browse browser browser-upload bulk-delete callback cancel capabilities catalog cc-switch changes channel-bots channels chat chat-sessions check commit commit-message complete-task completion-notifications concurrency config configuration configure confirm connectors contacts content context contract control-status coordinator coordinator-config copy create credentials current custom decision-models default-model default-steps delegate delegations delete deliveries desktop-runtime devices diff digital-person directory directory-openers disable discard discussion-groups document download draft edit engine engines enhance-config enhance-prompt entry events execution execution-config execution-report existing export faces feedback fetch fetch-remote file file-changes file-preview files force-approve fork fs gateway gateway-platform gateway-task-shares generate git global group-whitelist groups handoff health history hook hooks html-resource identity ignore image import init initialize inspect install intervention interventions knowledge language-packs list live-message local-workspace login logout main-session managed memory merge merge-into message messages meta mkdir mode model-pricing model-settings models next notification notification-hooks notification-options offer onboarding open open-directory open-file open-session-journal operation operations overview pause pending pending-message-inserts people permission-mode platform-share preferences prepare preview private-whitelist project project-actions project-audit project-raw projects prompt prototype provider providers public public-key publication pull push push-branch quick-buttons quota raw read receive recent recent-groups records recoveries recovery reference refresh register reject release remote-project remotes rename reorder repositories rescan reset-trust resources respond restart restore resume retry reveal review reviews revision revoke role-binding role-center roles rollback run run-now runs runtime samples save save-steps scan scans schedule scheduled-start schedules search secret selection send sender serve sessions set-complete settings share skills skins source sources speech speech-output standing-memory start statistics status step steps stop storage subscriptions summary switch sync system system-prompt system-settings task task-dispatch task-draft task-share tasks teams templates terminate test unarchive unlock update upload uploads validate view visibility voice-wake voices weixin welcome workflow workflow-debug workflows workspace worktrees').split(' '))

// Public segments introduced by calendar, delegation and voiceprint APIs.
for (const route of 'calendar claim code delegation-options enroll info receipts remind target targets verify voice voiceprint'.split(' ')) ROUTES.add(route)

const ENGINE_ROUTES = new Set(('execution coordinator config refresh test custom import onboarding disable rollback export visibility runtime operation install update inspect quota models default-model binary-path reveal').split(' '))
const PUBLIC_ENGINES = new Set(('codex codex_sdk claude claude_code claude_agent_sdk gemini gemini_cli copilot opencode cursor pydantic_ai').split(' '))

export function diagnosticRoute(value) {
  let path = String(value).split(/[?#]/, 1)[0]
  try { if (/^https?:\/\//i.test(path)) path = new URL(path).pathname } catch { return '/:id' }
  const segments = path.split('/').filter(Boolean)
  const engineIndex = segments.indexOf('engine')
  return '/' + segments.map((segment, index) =>
    ROUTES.has(segment) || (engineIndex >= 0 && index > engineIndex &&
      (ENGINE_ROUTES.has(segment) || (index === engineIndex + 1 && PUBLIC_ENGINES.has(segment)))) ? segment : ':id').join('/')
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
