import type { WebRtcConnectionHandle } from './peerClient'

declare global {
  interface Window {
    __workstepDirect?: { handle: WebRtcConnectionHandle; adopted: boolean }
  }
}

export function takeBootstrapConnection(deviceId: string): WebRtcConnectionHandle | undefined {
  const current=window.__workstepDirect
  if(!current||current.adopted||current.handle.deviceId!==deviceId||!current.handle.transport.isOpen)return
  current.adopted=true
  return current.handle
}

export function publishDirectConnection(handle: WebRtcConnectionHandle): void {
  if(window.__workstepDirect)window.__workstepDirect={handle,adopted:true}
}
