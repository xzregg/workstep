import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../WorkStep/Resources/bridge.js', import.meta.url), 'utf8')
function page(origin, topFrame = true) {
  const messages = [], listeners = {}
  const window = { location: { origin }, webkit: { messageHandlers: { workstep: { postMessage: value => messages.push(value) } } },
    addEventListener: (type, callback) => { listeners[type] = callback } }
  window.top = topFrame ? window : {}
  const context = { window, location: window.location, URL, __workstepOrigin: 'https://host' }
  vm.runInNewContext(source, context)
  return { window, messages, listeners }
}
test('bridge exists only on configured origin in main frame', () => {
  assert.equal(page('https://identity').window.WorkStepIOS, undefined)
  assert.equal(page('https://host', false).window.WorkStepIOS, undefined)
  assert.ok(page('https://host').window.WorkStepIOS)
})
test('bridge forwards bounded JSON without exposing Android identity', () => {
  const { window, messages } = page('https://host')
  window.WorkStepIOS.postMessage('{"type":"notify","id":"one"}')
  window.WorkStepIOS.postMessage('invalid')
  window.WorkStepIOS.postMessage('x'.repeat(70000))
  assert.equal(messages.length, 1)
  assert.equal(messages[0].id, 'one')
  assert.equal(window.WorkStepAndroid, undefined)
})
test('diagnostics omit page content and URL secrets', () => {
  const { listeners, messages } = page('https://host')
  listeners.error({ filename: 'https://host/assets/main.js?token=secret#secret', lineno: 2,
    message: 'sensitive user content', error: { name: 'TypeError' } })
  assert.equal(messages[0].code, 'TypeError')
  assert.equal(messages[0].path, '/assets/main.js')
  assert.ok(!JSON.stringify(messages).includes('secret'))
  assert.ok(!JSON.stringify(messages).includes('sensitive'))
})

test('system speech bridge forwards bounded requests and receives per-utterance acknowledgements', () => {
  const { window, messages } = page('https://host')
  assert.ok(window.WorkStepSpeech)
  let result
  window.WorkStepSpeech.onmessage = event => { result = JSON.parse(event.data) }
  window.WorkStepSpeech.postMessage(JSON.stringify({type:'speak',id:'one',text:'你好',rate:1,volume:1}))
  window.WorkStepSpeech.postMessage(JSON.stringify({type:'stop',id:'one'}))
  window.WorkStepSpeech.postMessage('invalid')
  window.WorkStepSpeech.postMessage('x'.repeat(70000))
  assert.equal(messages.length, 2)
  assert.equal(messages[0].type, 'systemSpeech')
  assert.equal(messages[0].request.id, 'one')
  assert.equal(messages[1].request.type, 'stop')
  window.WorkStepSpeech.onmessage({data:JSON.stringify({id:'one',status:'done'})})
  assert.equal(result.status, 'done')
  assert.equal(page('https://identity').window.WorkStepSpeech, undefined)
  assert.equal(page('https://host',false).window.WorkStepSpeech, undefined)
})
