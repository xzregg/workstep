import { gatewayFetch } from '../utils/gatewayWorkspacePath'
import { browserActorHeaders } from '../utils/browserActor'
import { retryWebRtcTransfer } from './retryTransfer'

/** Offline resources for one capability frame. Never fetch outside its ticket. */
export class DirectHtmlResources {
  private abort = new AbortController()
  private pending = new Map<string, Promise<string>>()
  private bytes = 0
  private urls: Record<string,string> = {}
  private root: URL
  constructor(root: string) { this.root = new URL(root, window.location.href) }

  private resolve(value: string, base: string): URL | null {
    const url = new URL(value, base)
    return url.origin === this.root.origin && url.pathname.startsWith(this.root.pathname) ? url : null
  }
  private async read(url: string): Promise<Response> {
    if (this.pending.size >= 128) throw new Error('Preview has too many resources')
    return retryWebRtcTransfer(async () => {
      const response = await gatewayFetch(url, {signal:this.abort.signal, headers:browserActorHeaders()})
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const blob=await response.blob()
      this.bytes+=blob.size
      if(this.bytes>20*1024*1024)throw new Error('Preview resources exceed 20 MiB')
      return new Response(blob,{headers:response.headers})
    },this.abort.signal)
  }
  private async data(blob: Blob): Promise<string> {
    const bytes=new Uint8Array(await blob.arrayBuffer())
    let binary=''
    for(let index=0;index<bytes.length;index+=32768)binary+=String.fromCharCode(...bytes.subarray(index,index+32768))
    return `data:${blob.type||'application/octet-stream'};base64,${btoa(binary)}`
  }
  private async css(source: string, base: string, ancestors: string[]): Promise<string> {
    const pattern=/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)]+))\s*\)|@import\s+(['"])([^'"]+)\4/g
    let out='',cursor=0
    for(const match of source.matchAll(pattern)){
      const value=match[1]||match[2]||match[3]||match[5]
      let resolved=value
      if(!value.startsWith('data:')&&!value.startsWith('#')){
        const url=this.resolve(value,base)
        resolved=url?await this.resource(url.href,ancestors):'data:,'
      }
      out+=source.slice(cursor,match.index)+(match[5]?`@import "${resolved}"`:`url("${resolved}")`)
      cursor=match.index!+match[0].length
    }
    return out+source.slice(cursor)
  }
  private resource(url: string, ancestors: string[]): Promise<string> {
    if(ancestors.includes(url)||ancestors.length>=8)return Promise.resolve('data:,')
    const existing=this.pending.get(url)
    if(existing)return existing
    const load=(async()=>{
      const response=await this.read(url)
      const type=response.headers.get('content-type')||''
      if(type.includes('text/html')||/\.html?(?:\?|$)/i.test(url)){
        const html=await this.document(url,[...ancestors,url],await response.text())
        this.abort.signal.throwIfAborted()
        // An opaque sandbox cannot navigate a child to its parent's Blob origin.
        return this.data(new Blob([html],{type:'text/html'}))
      }
      if(type.includes('text/css')||/\.css(?:\?|$)/i.test(url))return this.data(new Blob([await this.css(await response.text(),url,[...ancestors,url])],{type:'text/css'}))
      const blob=await response.blob()
      // Some older hosts serve JS with a generic content type.
      return this.data(/\.m?js(?:\?|$)/i.test(url)?new Blob([blob],{type:'text/javascript'}):blob)
    })().then(value=>{this.urls[url]=value;return value})
    this.pending.set(url,load)
    return load
  }
  async document(url: string, ancestors: string[] = [url], content?: string): Promise<string> {
    if(!this.resolve(url,this.root.href))throw new Error('Preview resource denied')
    const request=new URL(url);request.searchParams.set('inline','true')
    const source=content??await (await this.read(request.href)).text()
    const doc=new window.DOMParser().parseFromString(source,'text/html')
    doc.querySelectorAll('base,meta[http-equiv="refresh"]').forEach(node=>node.remove())
    // Preserve the host's nonce policy in edit mode; only frame targets change to offline blobs.
    doc.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').forEach(node=>{
      const policy=node.getAttribute('content')||''
      node.setAttribute('content',policy.replace(/frame-src[^;]*/g,'frame-src blob: data:'))
      const nonce=policy.match(/script-src 'nonce-([^']+)'/)
      if(nonce)doc.querySelectorAll('script').forEach(script=>{if(script.getAttribute('nonce')!==nonce[1])script.remove()})
    })
    for(const node of doc.querySelectorAll('[src],[href],[poster],[srcset],style,[style]')){
      if(node.tagName==='STYLE')node.textContent=await this.css(node.textContent||'',url,ancestors)
      if(node.hasAttribute('style'))node.setAttribute('style',await this.css(node.getAttribute('style')||'',url,ancestors))
      node.removeAttribute('srcset')
      for(const attribute of ['src','href','poster']){
        const value=node.getAttribute(attribute)
        if(!value||value.startsWith('#')||value.startsWith('data:'))continue
        const target=this.resolve(value,url)
        // Navigation is kept inside the capability, never the workspace/API origin.
        if(attribute==='href'&&node.tagName!=='LINK'&&!/\.html?$/i.test(target?.pathname||'')){node.setAttribute(attribute,'#');continue}
        node.setAttribute(attribute,target?await this.resource(target.href,ancestors):'data:,')
        node.removeAttribute('integrity');node.removeAttribute('crossorigin')
      }
    }
    const policy=doc.createElement('meta')
    policy.httpEquiv='Content-Security-Policy'
    policy.content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' data: blob:; style-src 'unsafe-inline' data: blob:; img-src data: blob:; font-src data: blob:; media-src data: blob:; connect-src 'none'; frame-src blob: data:; object-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'"
    doc.head.prepend(policy)
    const registry=doc.createElement('script')
    registry.setAttribute('nonce',decodeURIComponent(this.root.pathname.split('/').filter(Boolean).at(-1)!))
    registry.textContent='window.__workstepPreviewBase='+JSON.stringify(this.root.href)+';window.__workstepPreviewResources='+JSON.stringify(this.urls).replaceAll('<','\\u003c')+';'
    policy.after(registry)
    return '<!doctype html>'+doc.documentElement.outerHTML
  }
  dispose(){this.abort.abort();this.pending.clear()}
}
