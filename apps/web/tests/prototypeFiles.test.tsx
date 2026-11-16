import {installDomEnvironment} from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {I18nProvider,useLocaleStore} from '../src/i18n'
import PrototypeFiles from '../src/components/prototype/PrototypeFiles'
import type {PrototypeState} from '../src/api/prototype'

test('prototype file tree is rooted at the active HTML directory even for legacy broad workspaces',async()=>{
  const {window}=installDomEnvironment()
  useLocaleStore.setState({locale:'zh-CN'})
  const container=document.body.appendChild(document.createElement('div')),root=createRoot(container)
  const files=['apps/desktop/help.html','tmp/demo/index.html','tmp/demo/detail.html','tmp/demo/assets/theme.css','tmp/demo-other/private.html','tmp/other/index.html']
  const work={id:'w',root:'.',status:'idle',pending:false,error:'',bytes:0,history:[],files,documents:files.filter(path=>path.endsWith('.html')).map(path=>({id:path,path}))} as PrototypeState
  const selected:string[]=[]
  let closes=0
  const render=(path:string)=>root.render(<I18nProvider><PrototypeFiles work={work} path={path} disabled={false} onSelect={path=>selected.push(path)} onClose={()=>closes++}/></I18nProvider>)
  try{
    await act(async()=>render('tmp/demo/index.html'))
    assert.equal(container.querySelector('[role=treeitem][aria-expanded]')?.textContent,'assets')
    assert.deepEqual([...container.querySelectorAll<HTMLButtonElement>('[role=treeitem]:not([aria-expanded])')].map(button=>button.textContent),['theme.css','detail.html','index.html'])
    assert.ok(!container.textContent?.includes('desktop'))
    const detail=container.querySelector<HTMLButtonElement>('button[title="detail.html"]')!
    assert.ok(container.querySelector('input[aria-label="搜索文件"]'),'reuses the searchable file tree')
    assert.equal(container.querySelector<HTMLButtonElement>('[title="assets/theme.css"]')!.disabled,true,'non-HTML assets cannot switch document')
    await act(async()=>detail.click())
    assert.deepEqual(selected,['tmp/demo/detail.html'])
    assert.equal(closes,1)
    assert.equal(Boolean(container.querySelector('input[type=checkbox]')),false,'pin option is removed')
    await act(async()=>detail.click())
    assert.equal(closes,2,'every file selection closes the tree')
    const search=container.querySelector<HTMLInputElement>('input[type=search]')!
    const setter=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')!.set!
    await act(async()=>{setter.call(search,'index');search.dispatchEvent(new window.Event('input',{bubbles:true}))})
    assert.deepEqual([...container.querySelectorAll('[role=treeitem]:not([aria-expanded])')].map(node=>node.textContent),['index.html'],'shared search filters scoped files')
    await act(async()=>render('tmp/other/index.html'))
    assert.deepEqual([...container.querySelectorAll<HTMLButtonElement>('[role=treeitem]:not([aria-expanded])')].map(button=>button.title),['index.html'],'scope follows active file')
    await act(async()=>render('index.html'))
    assert.ok([...container.querySelectorAll('[role=treeitem][aria-expanded]')].some(node=>node.textContent?.startsWith('apps/')),'root-level HTML uses workspace root')
  }finally{await act(async()=>root.unmount());container.remove();await window.happyDOM.close()}
})
