import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

test('resource worker isolates devices and keeps signaling/bootstrap outside the direct route',()=>{
  const context=vm.createContext({URL,self:{addEventListener(){}}})
  vm.runInContext(readFileSync(new URL('../src/webrtc/bootstrap/worker.js',import.meta.url),'utf8'),context)
  const route=(value:string,client='https://gateway.test/p2p/device/chat')=>context.directRoute(value,client)
  assert.equal(route('https://gateway.test/p2p/device/__host/assets/main-abcd1234.js').path,'/assets/main-abcd1234.js')
  assert.equal(route('https://gateway.test/assets/main-abcd1234.js').key,'https://gateway.test/p2p/device/__host/assets/main-abcd1234.js')
  assert.notEqual(route('https://gateway.test/assets/main-abcd1234.js').key,route('https://gateway.test/assets/main-abcd1234.js','https://gateway.test/p2p/another/').key)
  for(const path of ['/api/webrtc/config','/p2p/rtc-worker.js','/p2p-bootstrap/bootstrap.js'])assert.equal(route('https://gateway.test'+path),null)
  assert.equal(route('https://outside.test/assets/main.js'),null)
  assert.equal(route('https://gateway.test/assets/main.js','https://gateway.test/admin'),null)
})
