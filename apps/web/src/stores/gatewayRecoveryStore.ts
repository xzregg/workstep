import { create } from 'zustand'

export const GATEWAY_RETRY_LIMIT = 3
export const GATEWAY_STABLE_MS = 30000

interface GatewayRecoveryState {
  paused: boolean
  dialogOpen: boolean
  retryRevision: number
  pause: () => void
  dismiss: () => void
  retry: () => void
}

// Shared by the event socket and session poller so neither can silently restart
// the other after the user dismisses the connection problem.
export const useGatewayRecoveryStore = create<GatewayRecoveryState>((set) => ({
  paused: false,
  dialogOpen: false,
  retryRevision: 0,
  pause: () => set(state => state.paused ? state : { paused: true, dialogOpen: true }),
  dismiss: () => set({ dialogOpen: false }),
  retry: () => set(state => ({ paused: false, dialogOpen: false, retryRevision: state.retryRevision + 1 })),
}))
