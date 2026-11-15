import {installDomEnvironment} from './helpers/domEnv'
import test from 'node:test'
import assert from 'node:assert/strict'
import {act} from 'react'
import {createRoot} from 'react-dom/client'
import {MemoryRouter} from 'react-router-dom'
import {I18nProvider} from '../src/i18n'
import SkinWorkspaceFrame from '../src/components/SkinExtensions'
import AvatarPresentation from '../src/components/AvatarPresentation'
import {defaultSkin} from '../src/skins/contract'
import {applySkin,restoreDefaultSkin} from '../src/skins/runtime'
import {setSkinScriptsEnabled} from '../src/skins/scriptPreferences'
import {setAppearanceScope} from '../src/utils/appearanceStorage'
import {getAvatarState,type AvatarPhase} from '../src/avatars/runtime'
import type {ExtensionApi} from '../src/skins/extensions'

test('skin can replace the avatar, follow host speech and restore the robot without changing the draft',async()=>{
 const {window}=installDomEnvironment(),host=document.body.appendChild(document.createElement('div')),root=createRoot(host)
 Object.assign(globalThis,{history:window.history})
 setAppearanceScope('avatar-host-test')
 const skin={...defaultSkin(),manifest:{...defaultSkin().manifest,id:'avatar-host',schema_version:2},revision:'one',script:'theme.js',file_base:'/api/skins/files/one'}
 applySkin(skin);setSkinScriptsEnabled(skin,true)
 let broken=false
 const loader=async()=>({activate(api:ExtensionApi){api.avatar.register({id:'fox',render:({state,name})=>{if(broken)throw new Error('broken avatar');return api.React.createElement('div',{'data-custom-avatar':true,'data-phase':state.phase,'data-hands':state.hands,'data-level':state.speech.level},name)}})}})
 const render=(phase:AvatarPhase,sessionId='a')=>root.render(<MemoryRouter><I18nProvider><SkinWorkspaceFrame onOpenSettings={()=>{}} loadModule={loader}>
  <AvatarPresentation projectId="p" sessionId={sessionId} phase={phase} speaking={phase==='speaking'} level={.6} name="小狐狸" fallback={()=> <span data-default-avatar>机器人</span>}/>
  <input aria-label="draft" defaultValue="保留草稿"/>
 </SkinWorkspaceFrame></I18nProvider></MemoryRouter>)
 try{
  await act(async()=>render('thinking'))
  const input=host.querySelector('input')!
  assert.equal(host.querySelector('[data-custom-avatar]')?.getAttribute('data-hands'),'raised')
  assert.equal(host.querySelector('[data-default-avatar]'),null)
  await act(async()=>render('speaking'))
  assert.equal(host.querySelector('[data-custom-avatar]')?.getAttribute('data-hands'),'lowered')
  assert.equal(host.querySelector('[data-custom-avatar]')?.getAttribute('data-level'),'0.6')
  await act(async()=>render('thinking','b'))
  assert.equal(getAvatarState({projectId:'p',sessionId:'a'}),null)
  assert.equal(getAvatarState({projectId:'p',sessionId:'b'})?.action,'raise-hand')
  const originalError=console.error
  try{
   console.error=()=>{}
   broken=true
   await act(async()=>render('speaking','b'))
   assert.ok(host.querySelector('[data-default-avatar]'),'a broken custom character falls back without rebuilding the workspace')
   assert.equal(host.querySelector('input'),input)
  }finally{console.error=originalError}
  await act(async()=>setSkinScriptsEnabled(skin,false))
  assert.ok(host.querySelector('[data-default-avatar]'))
  assert.equal(host.querySelector('[data-custom-avatar]'),null)
  assert.equal(host.querySelector('input'),input);assert.equal(input.value,'保留草稿')
 }finally{
  await act(async()=>root.unmount());restoreDefaultSkin();setAppearanceScope(null);await window.happyDOM.close()
 }
 assert.equal(getAvatarState({projectId:'p',sessionId:'b'}),null)
})
