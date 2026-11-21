import assert from 'node:assert/strict'
import test from 'node:test'
import { readDigitalPersonUiReply } from '../src/components/digital-person/digitalPersonUiReply'

const fence = '```workstep-ui'
const block = (json: string) => fence + '\n' + json + '\n' + '```' + '\n'

test('only accepts an entire protocol reply with an allowlisted action and valid arguments', () => {
  const open = block('{"action":"conversation.open","title":" 发布复盘 ","project":"网站"}')
  assert.deepEqual(readDigitalPersonUiReply(open), {
    text: '', action: { action: 'conversation.open', title: '发布复盘', project: '网站' },
  })
  assert.deepEqual(readDigitalPersonUiReply(block('{"action":"window.close"}')).action, { action: 'window.close' })
  for (const body of [
    open + '这是示例', '这是示例\n' + open, block('{"action":"camera.open"}'),
    block('{"action":"window.close","target":"other"}'), block('{"action":"conversation.open","title":" " }'),
    `${fence}\n{"action":"window.close"}`, open + open,
  ]) assert.equal(readDigitalPersonUiReply(body).action, undefined)
})

test('buffers streaming marker prefixes and hides malformed or unfinished payloads from presentation', () => {
  for (let end = 1; end <= fence.length; end++) {
    assert.equal(readDigitalPersonUiReply(fence.slice(0, end), true).text, '')
  }
  assert.equal(readDigitalPersonUiReply('```', false).text, '```')
  assert.equal(readDigitalPersonUiReply('```json\n{"sample":true}\n```').text, '```json\n{"sample":true}\n```')
  assert.equal(readDigitalPersonUiReply(`${fence}\n{"action":`, true).text, '')
  assert.equal(readDigitalPersonUiReply(block('{broken')).text, '')
  assert.equal(readDigitalPersonUiReply('前言\n' + block('{"action":"window.close"}') + '正文').text, '前言\n正文')
})
