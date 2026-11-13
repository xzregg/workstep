import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { I18nProvider } from '../src/i18n'
import { digitalPersonApi } from '../src/api/digitalPerson'
import { useProjectStore } from '../src/stores/projectStore'
import DigitalPersonChatButton from '../src/components/digital-person/DigitalPersonChatButton'

test('chat entry keeps the settings on failure and opens a concrete session on retry', async () => {
  const { window } = installDomEnvironment()
  const original = {...digitalPersonApi}, state = useProjectStore.getState()
  const container = document.body.appendChild(document.createElement('div')), root = createRoot(container)
  let closed = 0
  const workspace = { id:'home',name:'默认工作区',type:'local',is_default_workspace:true } as any
  function Surface() { const location = useLocation(); return <><DigitalPersonChatButton workspace={workspace} onClose={()=>closed++}/><output>{location.search}</output></> }
  try {
    digitalPersonApi.mainSession = async () => { throw new Error('暂时断开') }
    await act(async()=>root.render(<MemoryRouter><I18nProvider><Surface/></I18nProvider></MemoryRouter>))
    await act(async()=>container.querySelector('button')!.click())
    assert.equal(closed,0)
    assert.match(container.querySelector('[role="alert"]')!.textContent!,/暂时断开/)
    digitalPersonApi.mainSession = async () => ({id:'existing',project_id:'home'} as any)
    await act(async()=>container.querySelector('button')!.click())
    const query = new URLSearchParams(container.querySelector('output')!.textContent!)
    assert.equal(query.get('session'),'existing')
    assert.equal(query.get('project'),'默认工作区')
    assert.equal(closed,1)
  } finally {
    await act(async()=>root.unmount()); Object.assign(digitalPersonApi,original)
    useProjectStore.setState(state); await window.happyDOM.close()
  }
})
