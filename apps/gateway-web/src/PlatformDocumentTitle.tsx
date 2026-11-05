import { useEffect } from 'react'
import { companyNameChanged, loadPlatformStatus } from './platformBranding'

export function PlatformDocumentTitle() {
  useEffect(() => {
    let active = true
    let edited = false
    function setTitle(name: string) {
      document.title = name ? `${name} · WORKSTEP 平台` : 'WORKSTEP 平台'
    }
    function changed(event: Event) {
      edited = true
      setTitle((event as CustomEvent<string>).detail)
    }
    setTitle('')
    window.addEventListener(companyNameChanged, changed)
    void loadPlatformStatus().then(status => {
      if (active && !edited) setTitle(status.company_display_name ?? '')
    }).catch(() => {})
    return () => { active = false; window.removeEventListener(companyNameChanged, changed) }
  }, [])
  return null
}
