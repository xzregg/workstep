import { useSyncExternalStore } from 'react'

const query = '(max-width: 1023px)'
function subscribe(callback: () => void) {
  const media = window.matchMedia(query)
  media.addEventListener('change', callback)
  return () => media.removeEventListener('change', callback)
}
function getSnapshot() {
  return typeof window !== 'undefined' && (window.matchMedia?.(query).matches ?? window.innerWidth <= 1023)
}
export function useCompactLayout() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
