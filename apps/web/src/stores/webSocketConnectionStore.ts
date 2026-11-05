import { create } from 'zustand'

/** Observations from the existing application socket; never opens a connection. */
export const useWebSocketConnectionStore = create<{
  connected: boolean
  latencyMs: number | null
}>(() => ({ connected: false, latencyMs: null }))
