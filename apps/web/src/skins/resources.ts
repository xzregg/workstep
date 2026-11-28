import { gatewayFetch } from '../utils/gatewayWorkspacePath'
import { browserActorHeaders } from '../utils/browserActor'
import { retryWebRtcTransfer } from '../webrtc/retryTransfer'

/** Blob URLs belong to one applied skin or extension session. */
export class SkinResources {
  private controller = new AbortController()
  private pending = new Map<string, Promise<string>>()
  private urls = new Map<string, string>()

  get(url: string): string {
    return this.urls.get(url) ?? url
  }

  load(url: string): Promise<string> {
    const existing = this.pending.get(url)
    if (existing) return existing
    const target = new URL(url, window.location.href)
    if (target.origin !== window.location.origin
      || !/^\/api\/skins\/(files|assets)\/[A-Za-z0-9]+\//.test(target.pathname)) {
      return Promise.reject(new Error('Invalid skin resource URL'))
    }
    const signal = this.controller.signal
    const promise = retryWebRtcTransfer(async () => {
      const response = await gatewayFetch(url, { signal, headers: browserActorHeaders() })
      if (!response.ok) throw new Error(`Skin resource HTTP ${response.status}`)
      return response.blob()
    }, signal).then(blob => {
      signal.throwIfAborted()
      const blobUrl = URL.createObjectURL(blob)
      this.urls.set(url, blobUrl)
      return blobUrl
    })
    this.pending.set(url, promise)
    return promise
  }

  async css(source: string): Promise<string> {
    const matches = [...source.matchAll(/url\("([^"]+)"\)/g)]
      .filter(match => /\/api\/skins\/(?:files|assets)\//.test(match[1]))
    let css = source
    for (const match of matches) {
      css = css.replaceAll(match[0], `url("${await this.load(match[1])}")`)
    }
    return css
  }

  dispose(): void {
    this.controller.abort()
    for (const url of this.urls.values()) URL.revokeObjectURL(url)
    this.urls.clear()
    this.pending.clear()
  }
}
