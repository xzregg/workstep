import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import Button from './Button'
import { useI18n } from '../i18n'
import './RuntimeDiagnosticsControl.css'

const RuntimeDiagnosticsPanel = lazy(() => import('./RuntimeDiagnosticsPanel'))

export default function RuntimeDiagnosticsControl() {
  const { t } = useI18n()
  const [state, setState] = useState<'idle' | 'recording' | 'ready'>('idle')
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (window.WorkStepAndroid || window.WorkStepIOS || window.workstepDesktop) return
    const update = () => {
      const snapshot = window.workstepPerformance?.snapshot()
      setState(snapshot?.recording ? 'recording' : snapshot?.result ? 'ready' : 'idle')
    }
    window.addEventListener('workstep:runtime-capture', update)
    return () => window.removeEventListener('workstep:runtime-capture', update)
  }, [])
  const close = useCallback(() => setOpen(false), [])
  return <>
    {state !== 'idle' && <div className="runtime-diagnostics-control">
      <Button variant="ghost" onClick={() => {
        if (state === 'recording') window.workstepPerformance?.stop()
        setState('idle')
        setOpen(true)
      }}>{state === 'recording' ? t('settings.runtimeDiagnosticsStop') : t('settings.runtimeDiagnosticsView')}</Button>
    </div>}
    {open && <Suspense fallback={null}>
      <RuntimeDiagnosticsPanel onClose={close} onRecord={close} />
    </Suspense>}
  </>
}
