import { useEffect, useState } from 'react'
import { speechApi } from '../api/speech'

/** Read the setting from the recording's host; unknown/unavailable stays off. */
export function useSpeechEnabled(projectId: string, allowed: boolean) {
  const [state, setState] = useState({ projectId: '', enabled: false })
  useEffect(() => {
    let disposed = false, loading = false, again = false
    setState({ projectId, enabled: false })
    if (!allowed) return
    const refresh = async () => {
      again = true
      if (loading) return
      loading = true
      while (again && !disposed) {
        again = false
        try {
          const status = await speechApi.status(projectId)
          if (!disposed && !again) setState({ projectId, enabled: status.enabled === true && status.ready !== false })
        } catch {
          if (!disposed && !again) setState({ projectId, enabled: false })
        }
      }
      loading = false
    }
    const changed = () => { void refresh() }
    const visible = () => { if (document.visibilityState !== 'hidden') changed() }
    changed()
    window.addEventListener('workstep:speech-settings-changed', changed)
    window.addEventListener('workstep:reconnected', visible)
    document.addEventListener('visibilitychange', visible)
    return () => {
      disposed = true
      window.removeEventListener('workstep:speech-settings-changed', changed)
      window.removeEventListener('workstep:reconnected', visible)
      document.removeEventListener('visibilitychange', visible)
    }
  }, [projectId, allowed])
  return allowed && state.projectId === projectId && state.enabled
}
