import { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import '../../../desktop/src/runtime-diagnostics.js'
import '../../../desktop/src/runtime-diagnostics-view.js'
import '../../../desktop/src/runtime-diagnostics.css'
import desktopPackage from '../../../desktop/package.json' with { type: 'json' }
import { browserDiagnostics } from '../utils/browserDiagnostics'
import { copyText } from '../utils/clipboard'
import { useOverlay } from '../hooks/useOverlay'
import Button from './Button'
import ResizablePanel from './ResizablePanel'
import Icon from './Icon'

export default function RuntimeDiagnosticsPanel({ onClose, onRecord }: { onClose: () => void; onRecord: () => void }) {
  const panel = useRef<HTMLDivElement>(null)
  const host = useRef<HTMLDivElement>(null)
  useOverlay(true, onClose, panel, false)
  useEffect(() => window.mountWorkstepDiagnostics?.(host.current!, {
    read: full => ({
      available: true,
      environment: { platform: 'browser', version: desktopPackage.version,
        runtime: /(?:Chrome|Firefox|Version|Edg)\/[\d.]+/.exec(navigator.userAgent)?.[0] ?? 'Browser' },
      performance: window.workstepPerformance!.snapshot(),
      ...(full ? { logs: browserDiagnostics.snapshot().map(record => ({
        at: Date.parse(record.at), source: record.kind, level: record.level, summary: record.detail.split('\n', 1)[0],
        detail: record.detail.includes('\n') ? record.detail.split('\n').slice(1).join('\n') : undefined,
      })).reverse() } : {}),
    }),
    start() {
      if (!window.workstepPerformance?.start()) return false
      onRecord()
      return true
    },
    clear() { browserDiagnostics.clear(); return Promise.resolve(true) },
    clearDescription: '清除当前页面保留的诊断日志？清除后无法恢复。',
    stop() { window.workstepPerformance?.stop() },
    async copy(text) { if (!(await copyText(text))) throw new Error('Clipboard unavailable') },
    async save(text) {
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }))
      const link = document.createElement('a')
      link.href = url
      link.download = 'WorkStep-runtime-diagnostics.json'
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      return true
    },
  }), [onRecord])

  return createPortal(<div className="rd-overlay" onMouseDown={event => {
    if (event.currentTarget === event.target) onClose()
  }}>
    <ResizablePanel ref={panel} className="rd-shell" minWidth={420} minHeight={360}
      role="dialog" aria-modal="true" aria-label="运行诊断" tabIndex={-1}>
      <header><h2 className="rd-title">运行诊断</h2>
        <Button variant="icon" aria-label="关闭" onClick={onClose}><Icon name="x" /></Button>
      </header>
      <div className="rd-content" ref={host} />
    </ResizablePanel>
  </div>, document.body)
}
