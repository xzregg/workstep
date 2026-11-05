import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { useAndroidNotificationNavigation } from '../src/hooks/useAndroidNotificationNavigation'
import { useProjectStore } from '../src/stores/projectStore'

test('notification clicks reuse the mounted router, including old scoped links', async () => {
  const { window } = installDomEnvironment()
  window.happyDOM.setURL('https://gateway.test/workspace/device/chat?project=Demo&session=s')
  const original = useProjectStore.getState()
  useProjectStore.setState({ projects: [{ id: 'p', name: 'Demo' } as never] })
  let resumes = 0
  window.addEventListener('workstep:resume', () => resumes++)
  const root = createRoot(document.body.appendChild(document.createElement('div')))
  function Harness() {
    useAndroidNotificationNavigation()
    const location = useLocation()
    return <output data-location-key={location.key}>{location.pathname + location.search}</output>
  }
  async function open(url: string) {
    const detail = { url, handled: false }
    await act(async () => window.dispatchEvent(new window.CustomEvent('workstep:open-notification', { detail })))
    return detail.handled
  }
  try {
    await act(async () => root.render(<MemoryRouter initialEntries={['/chat?project=Demo&session=s']}><Harness /></MemoryRouter>))
    const initialKey = document.querySelector('output')?.getAttribute('data-location-key')
    assert.equal(await open('https://gateway.test/chat?project=gateway%2Fdevice%2Fp&session=s'), true)
    assert.equal(document.querySelector('output')?.textContent, '/chat?project=Demo&session=s')
    assert.equal(document.querySelector('output')?.getAttribute('data-location-key'), initialKey)
    assert.equal(resumes, 1)
    assert.equal(await open('https://gateway.test/tasks?project=gateway%2Fdevice%2Fp&task=t&workflow=f'), true)
    assert.equal(document.querySelector('output')?.textContent, '/tasks?project=Demo&task=t&workflow=f')
    assert.equal(await open('https://gateway.test/workspace/device/chat?project=Demo&session=new'), true)
    assert.equal(document.querySelector('output')?.textContent, '/chat?project=Demo&session=new')
    for (const url of [
      'https://gateway.test/chat?project=gateway%2Fother%2Fp&session=s',
      'https://gateway.test/chat?project=gateway%2Fdevice%2Funknown&session=s',
      'https://other.test/workspace/device/chat?project=Demo&session=s',
      'https://gateway.test/workspace/other/chat?project=Demo&session=s',
      'https://gateway.test/workspace/device/chat?project=Demo',
    ]) assert.equal(await open(url), false, url)
  } finally {
    await act(async () => root.unmount())
    useProjectStore.setState(original)
    await window.happyDOM.close()
  }
})
