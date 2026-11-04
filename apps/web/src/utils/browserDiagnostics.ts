import { diagnosticRoute, redactDiagnosticText, type DiagnosticPrivacyContext } from '../../../desktop/src/diagnostic-privacy.mjs'
import desktopPackage from '../../../desktop/package.json' with { type: 'json' }

interface DiagnosticRecord { at: string; kind: 'page' | 'request'; detail: string }
type PrivacyContext = () => DiagnosticPrivacyContext

function bounded(value: string, maxBytes = 2048): string {
  const bytes = new TextEncoder().encode(value)
  return bytes.length <= maxBytes ? value : new TextDecoder().decode(bytes.subarray(0, maxBytes - 4), { stream: true }) + '…'
}

function errorText(reason: unknown): string {
  if (typeof reason === 'string') return reason.length > 65536 ? '[oversized error omitted]' : reason
  if (reason instanceof Error) return errorText(reason.stack || reason.message || reason.name)
  return '[non-error rejection omitted]'
}

export function createBrowserDiagnostics(privacy: PrivacyContext = () => ({})) {
  const records: DiagnosticRecord[] = []
  const requestErrors = new WeakMap<object, string>()
  let context = privacy
  function record(kind: DiagnosticRecord['kind'], text: string) {
    const detail = bounded(kind === 'request' ? text : redactDiagnosticText(text, context()))
    const now = new Date().toISOString()
    if (records.at(-1)?.detail === detail && Date.parse(now) - Date.parse(records.at(-1)!.at) < 5000) return
    records.push({ at: now, kind, detail })
    if (records.length > 100) records.shift()
  }
  return {
    setPrivacyContext(next: PrivacyContext) { context = next },
    recordError(reason: unknown) {
      const request = reason && typeof reason === 'object' ? requestErrors.get(reason) : undefined
      record(request ? 'request' : 'page', request || errorText(reason))
    },
    recordRequestFailure(path: string, method: string, status?: number, reason?: unknown) {
      const safeMethod = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(method) ? method : 'REQUEST'
      const detail = `${safeMethod} ${diagnosticRoute(path)} ${status ? `HTTP ${status}` : 'network failure'}`
      if (reason && typeof reason === 'object') requestErrors.set(reason, detail)
      record('request', detail)
    },
    snapshot() { return records.map(item => ({ ...item, detail: item.kind === 'request' ? item.detail : bounded(redactDiagnosticText(item.detail, context())) })) },
    clear() { records.length = 0 },
  }
}

export const browserDiagnostics = createBrowserDiagnostics()
type BrowserDiagnostics = ReturnType<typeof createBrowserDiagnostics>
const installations = new WeakMap<Window, () => void>()

export function installBrowserDiagnostics(target: Window, diagnostics: BrowserDiagnostics = browserDiagnostics): () => void {
  const existing = installations.get(target)
  if (existing) return existing
  const error = (event: ErrorEvent) => diagnostics.recordError(event.error || event.message)
  const rejection = (event: PromiseRejectionEvent) => diagnostics.recordError(event.reason)
  target.addEventListener('error', error)
  target.addEventListener('unhandledrejection', rejection)
  const dispose = () => {
    target.removeEventListener('error', error)
    target.removeEventListener('unhandledrejection', rejection)
    installations.delete(target)
  }
  installations.set(target, dispose)
  return dispose
}

function browserInfo(userAgent: string): string {
  const browser = /(?:Edg|Chrome|Firefox|Version)\/[\d.]+/.exec(userAgent)?.[0] || '不可用'
  const os = /(?:Windows NT [\d.]+|Android [\d.]+|(?:iPhone )?OS [\d_]+|Mac OS X [\d_]+|Linux)/.exec(userAgent)?.[0] || '不可用'
  return `${browser} / ${os}`
}

export function buildBrowserFeedback({ window: target = window, diagnostics = browserDiagnostics, version = desktopPackage.version }: {
  window?: Window; diagnostics?: BrowserDiagnostics; version?: string
} = {}): string {
  const performance = target.performance
  const startedAt = Number.isFinite(performance?.timeOrigin) ? new Date(performance.timeOrigin).toISOString() : '不可用'
  const uptime = Math.max(0, Math.floor((performance?.now() || 0) / 1000))
  const records = diagnostics.snapshot()
  return [
    'WorkStep 问题反馈', '', '问题描述：', '复现步骤：', '预期结果：', '',
    `生成时间：${new Date().toISOString()}（${Intl.DateTimeFormat().resolvedOptions().timeZone}）`,
    `前端版本：${version}`, `客户端：${target.WorkStepAndroid ? 'Android' : /Android|iPhone|iPad|Mobile/i.test(target.navigator.userAgent) ? '移动浏览器' : '浏览器'}`,
    `浏览器与系统：${browserInfo(target.navigator.userAgent)}`, `当前页面：${diagnosticRoute(target.location.pathname)}`,
    `页面启动时间：${startedAt}`, `页面运行时长：${Math.floor(uptime / 3600)}小时${Math.floor(uptime / 60) % 60}分${uptime % 60}秒`,
    `网络状态：${target.navigator.onLine ? '在线' : '离线'}`, '后台文件日志与桌面进程信息：不可用（当前客户端未读取）', '',
    '近期页面异常与接口失败（仅本次页面运行，最多 100 条；已脱敏，长记录截断）',
    ...records.map(record => `${record.at} [${record.kind}] ${record.detail}`),
    ...(records.length ? [] : ['暂无已记录异常。']), '',
    '不包含请求头、请求／响应正文、聊天正文或完整配置。截图需自行检查敏感信息后附上。',
  ].join('\n')
}
