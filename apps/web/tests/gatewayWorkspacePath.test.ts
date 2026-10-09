import assert from 'node:assert/strict'
import test from 'node:test'
import {gatewayWorkspacePath, gatewayResourceUrl} from '../src/utils/gatewayWorkspacePath'
test('device path scopes HTTP, files and websocket URLs without touching external URLs',()=>{
 const old=Object.getOwnPropertyDescriptor(globalThis,'window')
 Object.defineProperty(globalThis,'window',{configurable:true,value:{location:{pathname:'/workspace/device-one/project/test',origin:'http://192.168.52.156:8700',host:'192.168.52.156:8700'}}})
 try{
  assert.equal(gatewayWorkspacePath(),'/workspace/device-one')
  assert.equal(gatewayResourceUrl('/ws?x=1'),'/ws/workspace/device-one?x=1')
  assert.equal(gatewayResourceUrl('/ws/workspace/device-one'),'/ws/workspace/device-one')
  assert.equal(gatewayResourceUrl('/ws/notifications'),'/ws/notifications')
  assert.equal(gatewayResourceUrl('/api/project/list'),'/workspace/device-one/api/project/list')
  assert.equal(gatewayResourceUrl('ws://192.168.52.156:8700/ws'),'ws://192.168.52.156:8700/ws/workspace/device-one')
  assert.equal(gatewayResourceUrl('/workspace/device-one/api/task/list'),'/workspace/device-one/api/task/list')
  assert.equal(gatewayResourceUrl('https://example.com/image.png'),'https://example.com/image.png')
 }finally{if(old)Object.defineProperty(globalThis,'window',old);else Reflect.deleteProperty(globalThis,'window')}
})
