import { isWebRtcRemoteBrowser } from './webrtcLocation'
import { useWebRtcConnectionStore } from './webrtcConnectionStore'

function waitForConnection(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {}
    const finish = (error?: Error) => {
      clearTimeout(timer)
      unsubscribe()
      signal?.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
    const onAbort = () => finish(new DOMException('The operation was aborted.', 'AbortError'))
    const timer = setTimeout(() => finish(new Error('WebRTC reconnect timed out')), 45000)
    const check = () => {
      const state = useWebRtcConnectionStore.getState()
      if (state.connected && !state.reconnecting) finish()
    }
    unsubscribe = useWebRtcConnectionStore.subscribe(check)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    else check()
  })
}

/** Retry a replayable transfer, including consumption of its response body. */
export async function retryWebRtcTransfer<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation()
    } catch (error) {
      const disconnected = error instanceof Error && /(?:WebRTC.*(?:DataChannel.*(?:closed|disconnected)|channel.*closed)|DataChannel is not open)/i.test(error.message)
      if (!isWebRtcRemoteBrowser() || !disconnected || attempt >= 2 || signal?.aborted) throw error
      window.dispatchEvent(new Event('workstep:webrtc-reconnect'))
      await waitForConnection(signal)
    }
  }
}
