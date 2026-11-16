import {installDomEnvironment} from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {I18nProvider,useLocaleStore} from '../src/i18n'
import PrototypeHistory from '../src/components/prototype/PrototypeHistory'

test('prototype history shows timestamps and the shared line-numbered diff in both modes',async()=>{
  const {window}=installDomEnvironment()
  useLocaleStore.setState({locale:'zh-CN'})
  const previousFetch=globalThis.fetch
  const time=Date.parse('2026-11-16T02:30:00Z')/1000
  const patch='--- index.html\n+++ index.html\n@@ -1 +1 @@\n-<p>08</p>\n+<p>9</p>\n'
  globalThis.fetch=async()=>Response.json({diff:patch,files:[{path:'index.html',patch},{path:'common.css',patch:'@@ -2 +2 @@\n-color:red\n+color:blue\n'}]})
  const root=createRoot(document.body.appendChild(document.createElement('div')))
  const work={id:'a'.repeat(32),root:'.',status:'idle',pending:false,error:'',bytes:100,documents:[],files:[],history:[{id:'r1',label:'style: index.html',time,changes:{}}]}
  try{
    await act(async()=>root.render(<I18nProvider><PrototypeHistory projectId="p" work={work} onClean={()=>{}} onClose={()=>{}}/></I18nProvider>))
    assert.equal(document.querySelector('time')?.dateTime,'2026-11-16T02:30:00.000Z')
    assert.match(document.querySelector('time')!.textContent!,/2026/)
    assert.match(document.querySelector('.git-code-cell.removed')!.textContent!,/08/)
    assert.match(document.querySelector('.git-code-cell.added')!.textContent!,/9/)
    assert.equal(document.querySelector('.git-line-number')?.textContent,'1')
    assert.equal(document.querySelectorAll('.git-code-pane').length,2)
    const toggle=[...document.querySelectorAll('button')].find(button=>button.textContent==='统一视图')!
    await act(async()=>toggle.click())
    assert.equal(document.querySelectorAll('.git-code-pane').length,0)
    assert.ok(document.querySelector('.git-code-cell.removed'))
    const file=document.querySelector<HTMLSelectElement>('select')!
    await act(async()=>{file.value='common.css';file.dispatchEvent(new window.Event('change',{bubbles:true}))})
    assert.match(document.querySelector('.git-code-cell.added')!.textContent!,/color:blue/)
    assert.equal(document.querySelector('.git-line-number')?.textContent,'2')
  }finally{await act(async()=>root.unmount());globalThis.fetch=previousFetch;await window.happyDOM.close()}
})
