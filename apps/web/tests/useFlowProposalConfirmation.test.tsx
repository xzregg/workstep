import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useFlowProposalConfirmation } from '../src/hooks/useFlowProposalConfirmation'

test('overwrite cancellation and source switches settle the card without applying; failures remain retryable', async () => {
  const { window } = installDomEnvironment(), el = document.body.appendChild(document.createElement('div')), root = createRoot(el)
  let controller!: ReturnType<typeof useFlowProposalConfirmation>, writes = 0
  function Harness({ scope }: { scope: string }) { controller=useFlowProposalConfirmation(scope);return <span>{controller.steps?.title}</span> }
  try {
    await act(async () => root.render(<Harness scope="one" />))
    let result!: Promise<boolean>
    await act(async () => { result=controller.request({title:'suggestion'},()=>{writes++}) })
    assert.equal(writes,0)
    await act(async () => controller.cancel())
    assert.equal(await result,false)
    await act(async () => { result=controller.request({title:'old'},()=>{writes++}) })
    await act(async () => root.render(<Harness scope="two" />))
    assert.equal(await result,false)
    assert.equal(writes,0)
    await act(async () => { result=controller.request({title:'new'},()=>{writes++}) })
    await act(async () => controller.confirm())
    assert.equal(await result,true);assert.equal(writes,1)
    let failure!: Promise<unknown>
    await act(async () => { failure=controller.request({title:'fail'},()=>{throw new Error('save failed')}).catch(error=>error) })
    await act(async () => controller.confirm())
    assert.match(String(await failure),/save failed/)
    assert.equal(controller.steps,null)
    await act(async () => { result=controller.request({title:'unmount'},()=>{writes++}) })
    await act(async () => root.unmount())
    assert.equal(await result,false);assert.equal(writes,1)
  } finally { await act(async () => root.unmount()); await window.happyDOM.close() }
})
