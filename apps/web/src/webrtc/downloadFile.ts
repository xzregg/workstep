import { browserActorHeaders } from '../utils/browserActor'
import { gatewayFetch } from '../utils/gatewayWorkspacePath'
import { shouldProxyWebRtcHttp } from './transportAdapter'
import { retryWebRtcTransfer } from './retryTransfer'
import { isWebRtcRemoteBrowser } from './webrtcLocation'

interface AndroidDownloadBridge {
  postMessage(message: string): void
  onmessage: ((event: { data: string }) => void) | null
}

declare global {
  interface Window {
    WorkStepP2pDownload?: AndroidDownloadBridge
  }
}

const activeDownloads = new WeakSet<AndroidDownloadBridge>()

function saveInBrowser(blob:Blob,filename:string){
  const url=URL.createObjectURL(blob),link=document.createElement('a')
  link.href=url;link.download=filename;document.body.appendChild(link);link.click();link.remove()
  window.setTimeout(()=>URL.revokeObjectURL(url),1000)
}

/** Save generated images/exports through the same native picker as direct files. */
export async function downloadWebRtcBlob(blob:Blob,filename:string):Promise<void>{
  const native=isWebRtcRemoteBrowser()?window.WorkStepP2pDownload:undefined
  if(!native){saveInBrowser(blob,filename);return}
  if(activeDownloads.has(native))throw new Error('A download is already in progress')
  activeDownloads.add(native)
  try{await saveToAndroid(native,blob.stream(),filename,blob.type)}
  finally{activeDownloads.delete(native)}
}

export async function downloadWebRtcFile(url: string, filename: string): Promise<void> {
  if (!shouldProxyWebRtcHttp(url)) throw new Error('Invalid direct download URL')
  const native = window.WorkStepP2pDownload
  if (native && activeDownloads.has(native)) throw new Error('A download is already in progress')
  if (native) activeDownloads.add(native)
  try {
    await retryWebRtcTransfer(async () => {
      const response = await gatewayFetch(url, { headers: browserActorHeaders() })
      if (!response.ok || !response.body) {
        await response.body?.cancel()
        throw new Error(`HTTP ${response.status}`)
      }
      if (native) await saveToAndroid(native, response.body, filename, response.headers.get('content-type') || '')
      else saveInBrowser(await response.blob(),filename)
    })
  } finally {
    if (native) activeDownloads.delete(native)
  }
}

async function saveToAndroid(native: AndroidDownloadBridge, body: ReadableStream<Uint8Array>, filename: string, mime: string) {
  const reader = body.getReader()
  const request = (message: Record<string, string>): Promise<string> => new Promise((resolve, reject) => {
    native.onmessage = ({ data }) => data === 'ok' || data === 'cancelled' ? resolve(data) : reject(new Error(data))
    native.postMessage(JSON.stringify(message))
  })
  try {
    if (await request({ type: 'start', filename, mime }) === 'cancelled') return
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      for (let offset = 0; offset < value.length; offset += 16384) {
        const part = value.subarray(offset, offset + 16384)
        const data = btoa(String.fromCharCode(...part))
        if (await request({ type: 'chunk', data }) === 'cancelled') return
      }
    }
    await request({ type: 'finish' })
  } catch (error) {
    try { native.postMessage(JSON.stringify({ type: 'abort' })) } catch { /* WebView may have gone away */ }
    throw error
  } finally {
    native.onmessage = null
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}
