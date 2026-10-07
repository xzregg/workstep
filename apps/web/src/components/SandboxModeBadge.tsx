import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'

export default function SandboxModeBadge() {
  const { t } = useI18n()
  const [running, setRunning] = useState(false)
  useEffect(() => {
    let cancelled = false
    const bridge = window.workstepDesktop?.sandbox
    if (bridge) void bridge.status().then(status => {
      if (!cancelled) setRunning(status.running)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [])
  return running ? <span className="layout-sidebar-sandbox-badge">{t('sandbox.modeBadge')}</span> : null
}
