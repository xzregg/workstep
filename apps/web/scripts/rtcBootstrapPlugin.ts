import { build, type Plugin, type ResolvedConfig } from 'vite'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

/** A separate bundle prevents the gateway entry from importing the workbench. */
export function rtcBootstrapPlugin(): Plugin {
  let config:ResolvedConfig
  return {
    name:'workstep-rtc-bootstrap',
    configResolved(value){config=value},
    async generateBundle(){
      const result=await build({configFile:false,root:config.root,publicDir:false,logLevel:'warn',
        build:{write:false,minify:true,cssTarget:['chrome80','safari13'],lib:{entry:fileURLToPath(new URL('../src/webrtc/bootstrap/main.ts',import.meta.url)),formats:['es'],fileName:()=> 'bootstrap.js',cssFileName:'style'},
          rolldownOptions:{output:{inlineDynamicImports:true,assetFileNames:'[name][extname]'}}}})
      const bundles=Array.isArray(result)?result:[result]
      for(const bundle of bundles)if('output'in bundle)for(const file of bundle.output){
        this.emitFile({type:'asset',fileName:'rtc-bootstrap/'+(file.fileName.endsWith('.css')?'style.css':file.fileName),source:file.type==='chunk'?file.code:file.source})
      }
      this.emitFile({type:'asset',fileName:'rtc-bootstrap/worker.js',source:await readFile(new URL('../src/webrtc/bootstrap/worker.js',import.meta.url),'utf8')})
      this.emitFile({type:'asset',fileName:'rtc-bootstrap/index.html',source:'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>WorkStep</title><link id="rtc-bootstrap-style" rel="stylesheet" href="/p2p-bootstrap/style.css"></head><body><div id="root"></div><script type="module" src="/p2p-bootstrap/bootstrap.js"></script></body></html>'})
    },
  }
}
