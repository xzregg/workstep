import { useEffect, useState } from 'react'
import { digitalPersonApi, type DigitalPersonProfile } from '../../api/digitalPerson'
export const DIGITAL_PERSON_CHANGED = 'workstep:digital-person-changed'
/** Only host-owned default-workspace chat loads the device identity. */
export function useDigitalPerson(eligible: boolean) {
  const [profile, setProfile] = useState<DigitalPersonProfile | null>(null)
  useEffect(() => {
    if (!eligible) { setProfile(null); return }
    let active = true, revision = 0
    const load = () => {
      const current = ++revision
      void digitalPersonApi.get().then(value => { if (active && current === revision) setProfile(value.enabled ? value : null) })
        .catch(() => { if (active && current === revision) setProfile(null) })
    }
    load(); window.addEventListener(DIGITAL_PERSON_CHANGED, load)
    return () => { active = false; window.removeEventListener(DIGITAL_PERSON_CHANGED, load) }
  }, [eligible])
  return eligible ? profile : null
}
