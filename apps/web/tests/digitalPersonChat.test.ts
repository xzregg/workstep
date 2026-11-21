import assert from 'node:assert/strict'
import test from 'node:test'
import { digitalPersonApi } from '../src/api/digitalPerson'
import { resolveDigitalPersonChat } from '../src/components/digital-person/digitalPersonChat'

test('main entry uses the server binding, deduplicates concurrent opens, and retries errors', async()=>{
 const original=digitalPersonApi.mainSession
 let calls=0
 digitalPersonApi.mainSession=async()=>{calls++;return {id:'main',project_id:'home'} as any}
 try {
  assert.deepEqual(await Promise.all([resolveDigitalPersonChat('home'),resolveDigitalPersonChat('home')]),['main','main'])
  assert.equal(calls,1)
  digitalPersonApi.mainSession=async()=>{throw new Error('offline')}
  await assert.rejects(resolveDigitalPersonChat('home'),/offline/)
  digitalPersonApi.mainSession=async()=>({id:'main',project_id:'other'} as any)
  await assert.rejects(resolveDigitalPersonChat('home'),/Digital human workspace has changed/)
 } finally {digitalPersonApi.mainSession=original}
})
