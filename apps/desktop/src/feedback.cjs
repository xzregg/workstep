const { isTrustedNavigation } = require('./security.cjs')
const { limitFeedbackText, extractLogErrors, summarizeErrors } = require('./feedback-summary.mjs')

function duration(value) {
  if (!Number.isFinite(value)) return '不可用'
  const seconds = Math.max(0, Math.floor(value))
  return `${Math.floor(seconds / 3600)}小时${Math.floor(seconds / 60) % 60}分${seconds % 60}秒`
}

function formatFeedback(report, runtime = {}) {
  const m = report.metadata || {}
  const errors = summarizeErrors(extractLogErrors(report.logs))
  return limitFeedbackText([
    'WorkStep 问题反馈', '问题描述：', '复现步骤：', '',
    `生成时间：${report.generatedAt || '不可用'}`,
    `应用版本：${m.version || '不可用'}；系统：${m.platform || '不可用'} ${m.osRelease || ''} ${m.arch || ''}`,
    `桌面运行时长：${duration(runtime.uptimeSeconds)}`,
    `后台：${runtime.backendMode || '不可用'} / ${runtime.backendState || '不可用'}`,
    ...(Number.isFinite(runtime.backendUptimeSeconds) ? [`后台运行时长：${duration(runtime.backendUptimeSeconds)}`] : []),
    '', '近期错误摘要（最多 5 类，重复已合并，仅保留关键堆栈）',
    ...(errors.length ? errors : ['未发现已记录的错误，请补充问题描述与复现步骤。']),
    ...(report.warnings || []).slice(0, 2).map(value => `采集提示：${limitFeedbackText(value, 200)}`),
    '', '需要完整日志时，可使用「导出诊断包」。',
  ].join('\n'))
}

function createFeedbackService({ diagnostics, runtime, clipboard, getWindow, rootUrl, sandboxLogs }) {
  let image = null, textCopied = false, pending = null, generation = 0
  return {
    copyText() {
      if (pending?.generation === generation) return pending.promise
      const current = generation
      image = null
      textCopied = false
      const promise = (async () => {
        const warnings = []
        let sandboxLog
        if (sandboxLogs) {
          try { sandboxLog = await sandboxLogs() }
          catch (error) { warnings.push(`沙箱日志不可用：${error.message}`) }
        }
        const report = await diagnostics.collectReport(sandboxLog, 64 * 1024)
        report.warnings = [...(report.warnings || []), ...warnings]
        let state = {}
        try { state = await runtime() }
        catch (error) { report.warnings.push(`后台状态不可用：${error.message}`) }
        const text = limitFeedbackText(diagnostics.redact(formatFeedback(report, state)))
        if (current !== generation) throw Error('反馈窗口已关闭')
        clipboard.writeText(text)
        textCopied = true
      })().finally(() => { if (pending?.promise === promise) pending = null })
      pending = { generation: current, promise }
      return promise
    },
    async capture() {
      if (!textCopied) throw Error('请先复制诊断文字')
      image = null
      const window = getWindow(), current = generation
      if (!window || window.isDestroyed() || !isTrustedNavigation(window.webContents.getURL(), rootUrl())) throw Error('当前没有可截图的 WorkStep 页面')
      const url = window.webContents.getURL()
      const captured = await window.webContents.capturePage()
      if (current !== generation) throw Error('反馈窗口已关闭')
      if (window.isDestroyed() || window.webContents.getURL() !== url) throw Error('WorkStep 页面已切换，请重新截图')
      if (captured.isEmpty()) throw Error('页面截图为空，请重试')
      image = captured
      return image.toDataURL()
    },
    async copyImage() {
      if (!image) throw Error('请先生成并检查截图')
      clipboard.writeImage(image)
    },
    clearImage() { image = null },
    clear() { generation++; image = null; textCopied = false },
  }
}

function registerFeedbackIpc({ ipcMain, getWindow, getFeedbackWindow, rootUrl, service, open }) {
  const handlers = {
    open: async event => {
      const window = getWindow()
      if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame || !isTrustedNavigation(event.senderFrame?.url, rootUrl())) throw Error('反馈操作来源无效')
      await open()
    },
    action: async (event, action) => {
      const window = getFeedbackWindow()
      if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw Error('反馈操作来源无效')
      if (action === 'copyText') return service.copyText()
      if (action === 'capture') return service.capture()
      if (action === 'copyImage') return service.copyImage()
      if (action === 'clearImage') { service.clearImage(); return }
      throw Error('反馈操作无效')
    },
  }
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.removeHandler(`workstep:feedback:${name}`)
    ipcMain.handle(`workstep:feedback:${name}`, handler)
  }
}

const attached = new WeakSet()
function captureRendererErrors(contents, logger, rootUrl) {
  if (attached.has(contents)) return
  attached.add(contents)
  const seen = new Map()
  contents.on('console-message', details => {
    if (details?.level !== 'error' || !isTrustedNavigation(contents.getURL(), rootUrl())) return
    if (details.frame?.url && !isTrustedNavigation(details.frame.url, rootUrl())) return
    const message = String(details.message || '').slice(0, 8192)
    const now = Date.now()
    if (now - (seen.get(message) || 0) < 5000) return
    seen.set(message, now)
    if (seen.size > 100) seen.delete(seen.keys().next().value)
    logger?.write('desktop', 'error', `[界面] ${message}`)
  })
}

module.exports = { formatFeedback, createFeedbackService, registerFeedbackIpc, captureRendererErrors }
