import { useRef } from 'react'
import { speechDestinationKey, type SpeechDestination, type SpeechSecrets } from '../api/speechCredentials'

const emptySecrets: SpeechSecrets = {
  api_key: null, secret_id: null, secret_key: null,
  has_api_key: false, has_secret_id: false, has_secret_key: false,
}

export function useSpeechConnections<T extends SpeechDestination & SpeechSecrets>(connections: readonly T[] = []) {
  const drafts = useRef<T[]>([])

  const remember = (value: T) => {
    if (value.mode === 'cloud' || value.mode === 'remote') {
      drafts.current = [value, ...drafts.current.filter(row => speechDestinationKey(row) !== speechDestinationKey(value))]
    }
  }
  const entries = (mode: string, provider?: string) =>
    [...drafts.current, ...connections].filter(row => row.mode === mode && (!provider || row.provider === provider))

  return {
    remember,
    reset: () => { drafts.current = [] },
    recent: (mode: string, provider?: string) => entries(mode, provider)[0],
    addresses: (value: T) => [...new Set(connections.filter(row => row.mode === value.mode && row.provider === value.provider)
      .map(row => row.base_url).filter(Boolean))],
    editDestination(current: T, next: T) {
      const key = speechDestinationKey(next)
      if (speechDestinationKey(current) === key) return next
      remember(current)
      const previous = entries(next.mode, next.provider).find(row => speechDestinationKey(row) === key)
      return previous ? { ...previous, base_url: next.base_url, app_id: next.app_id, region: next.region } : { ...next, ...emptySecrets }
    },
  }
}
