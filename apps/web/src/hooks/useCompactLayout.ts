import { useSyncExternalStore } from 'react'
import { skinContract } from '../skins/contract'

const query = `(max-width: ${skinContract.breakpoint}px)`
function subscribe(callback: () => void) {
  const media = window.matchMedia(query)
  media.addEventListener('change', callback)
  return () => media.removeEventListener('change', callback)
}
export function useCompactLayout() {
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => false)
}
