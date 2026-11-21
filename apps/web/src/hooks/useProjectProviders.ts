import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { providerApi, type ProviderInfo } from '../api/client'
import { singleFlight } from '../api/transport'

const useProviderRevision = create<{ revision: number }>(() => ({ revision: 0 }))

/** Settings overlays leave composers mounted; invalidate their project-scoped lists. */
export function notifyProvidersChanged() {
  useProviderRevision.setState(state => ({ revision: state.revision + 1 }))
}

const EMPTY_PROVIDERS: ProviderInfo[] = []

export function useProjectProviders(projectId: string) {
  const revision = useProviderRevision(state => state.revision)
  const [catalog, setCatalog] = useState<{ projectId: string; providers: ProviderInfo[] } | null>(null)
  useEffect(() => {
    let active = true
    if (!projectId) return
    void singleFlight(`composer-providers::${projectId}::${revision}`, () => providerApi.list(projectId))
      .then(result => {
        if (active) setCatalog({ projectId, providers: result.providers.filter(item => item.enabled) })
      })
      .catch(() => { /* provider list is optional for the engine picker */ })
    return () => { active = false }
  }, [projectId, revision])
  return catalog?.projectId === projectId ? catalog.providers : EMPTY_PROVIDERS
}
