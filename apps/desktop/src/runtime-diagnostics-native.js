;(function () {
  if (!window.runtimeDiagnosticsHost && window.androidRuntimeDiagnostics) {
    let id = 0
    const pending = new Map()
    window.resolveRuntimeDiagnostics = (request, result, failed) => {
      const callback = pending.get(request)
      if (!callback) return
      pending.delete(request)
      clearTimeout(callback.timeout)
      if (failed) callback.reject(new Error('Android diagnostics operation failed'))
      else callback.resolve(result)
    }
    window.runtimeDiagnosticsHost = {
      invoke(action, value) {
        return new Promise((resolve, reject) => {
          const request = ++id
          const timeout = setTimeout(() => { pending.delete(request); reject(new Error('Diagnostics operation timed out')) }, 30000)
          pending.set(request, { resolve, reject, timeout })
          window.androidRuntimeDiagnostics.invoke(request, action, String(value ?? ''))
        })
      },
    }
  }
  const { invoke } = window.runtimeDiagnosticsHost
  window.mountWorkstepDiagnostics(document.getElementById('runtime-diagnostics'), {
    async read(full) {
      const result = await invoke(full ? 'read' : 'status')
      if (result.streams) result.logs = window.workstepRuntimeDiagnostics.normalizeLogs(result.streams)
      return result
    },
    start: () => invoke('start'),
    stop: () => invoke('stop'),
    copy: text => invoke('copy', text),
    save: text => invoke('save', text),
    clear: () => invoke('clear'),
    clearDescription: window.androidRuntimeDiagnostics
      ? '清除安卓主进程、通知进程、崩溃和当前网页的诊断日志？清除后无法恢复。'
      : '清除本机桌面日志、桌面收集的后台日志和当前网页诊断日志？沙箱日志由容器管理。清除后无法恢复。',
    ...(window.androidRuntimeDiagnostics ? { manage: () => invoke('manage') } : {}),
  })
})()
