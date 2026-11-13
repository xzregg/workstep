import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter } from 'react-router-dom'
import { I18nProvider, useLocaleStore } from '../src/i18n'
import { digitalPersonApi } from '../src/api/digitalPerson'
import { DIGITAL_PERSON_CHANGED } from '../src/components/digital-person/useDigitalPerson'
import DigitalPersonSidebarEntry from '../src/components/digital-person/DigitalPersonSidebarEntry'

test('default workspace entry follows the enabled digital person name; ordinary projects do not load it', async () => {
  const { window } = installDomEnvironment()
  useLocaleStore.setState({locale:'zh-CN'})
  const container = document.body.appendChild(document.createElement('div')), root = createRoot(container)
  const original = digitalPersonApi.get
  let name = '小研', enabled = true, calls = 0
  digitalPersonApi.get = async () => { calls++; return {name,enabled,role:'',duties:'研发',personality:'',greeting:'',avatar:'robot'} }
  const render = (home: boolean) => act(async()=>root.render(<MemoryRouter><I18nProvider><DigitalPersonSidebarEntry project={{id:'p',name:'工作区',is_default_workspace:home} as any}/></I18nProvider></MemoryRouter>))
  try {
    await render(false); assert.equal(calls,0); assert.equal(container.textContent,'')
    await render(true); assert.equal(container.querySelector('button')!.textContent,'与小研对话')
    name='小舟'
    await act(async()=>window.dispatchEvent(new window.Event(DIGITAL_PERSON_CHANGED)))
    assert.equal(container.querySelector('button')!.textContent,'与小舟对话')
    enabled=false
    await act(async()=>window.dispatchEvent(new window.Event(DIGITAL_PERSON_CHANGED)))
    assert.equal(container.querySelector('button'),null)
  } finally { await act(async()=>root.unmount()); digitalPersonApi.get=original; await window.happyDOM.close() }
})
