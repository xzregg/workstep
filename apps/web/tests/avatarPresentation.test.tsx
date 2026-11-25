import {installDomEnvironment} from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import AvatarPresentation from '../src/components/AvatarPresentation'

test('reading pauses avatar motion without replacing the renderer and restores it on close',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 window.matchMedia=(()=>({matches:false,addEventListener(){},removeEventListener(){}})) as typeof window.matchMedia
 const render=(paused:boolean)=>act(async()=>root.render(<AvatarPresentation name="小研" projectId="p" sessionId="main" phase="thinking" paused={paused} fallback={state=><div data-paused={String(state.reducedMotion)} data-phase={state.phase}/>}/>))
 try{
  await render(false)
  const avatar=host.querySelector('[data-paused]')!
  assert.equal(avatar.getAttribute('data-paused'),'false')
  await render(true)
  assert.ok(host.querySelector('[data-paused]') === avatar, 'keep the current canvas/skin mounted')
  assert.equal(avatar.getAttribute('data-paused'),'true')
  assert.equal(avatar.getAttribute('data-phase'),'thinking','pause motion without changing conversation state')
  await render(false)
  assert.equal(avatar.getAttribute('data-paused'),'false')
 }finally{await act(async()=>root.unmount());await window.happyDOM.close()}
})
