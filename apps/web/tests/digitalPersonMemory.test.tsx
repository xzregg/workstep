import { installDomEnvironment } from './helpers/domEnv'
import assert from 'node:assert/strict'
import test from 'node:test'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../src/i18n'
import DigitalPersonMemory from '../src/components/digital-person/DigitalPersonMemory'

test('native memory filters, selects related evidence, confirms experiences and resets locally', async () => {
  const { window } = installDomEnvironment()
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  const click = async (text: string) => {
    const button = [...container.querySelectorAll('button')].find(b => b.textContent === text)
    assert.ok(button, text)
    await act(async () => button.click())
  }
  const detail = () => container.querySelector('.digital-memory-detail')!
  try {
    await act(async () => root.render(<I18nProvider><DigitalPersonMemory name="小舟" avatar="robot" /></I18nProvider>))
    assert.equal(container.querySelector('iframe'), null)
    assert.match(container.textContent!, /小舟的记忆脑图/)
    assert.equal(container.querySelectorAll('.digital-memory-node-list button').length, 8)
    await click('本轮唤起')
    assert.equal(container.querySelectorAll('.digital-memory-node-list button').length, 4)
    await click('长期记忆')
    assert.equal(container.querySelectorAll('.digital-memory-node-list button').length, 2)
    await click('陈禾：只通知最终结果')
    assert.match(detail().textContent!, /仅在结果可用或需要我处理问题时通知我/)
    await click('停用这条记忆')
    assert.match(detail().textContent!, /已停用/)
    await click('本轮唤起')
    assert.equal(container.querySelectorAll('.digital-memory-node-list button').length, 4, 'past snapshot stays intact')
    await click('夜巡归档')
    assert.match(detail().textContent!, /待确认/)
    assert.doesNotMatch(container.querySelector('.digital-memory-node-list')!.textContent!, /先核对文件完整性/)
    await click('确认保存经验')
    assert.match(detail().textContent!, /校验失败先核对文件完整性/)
    assert.equal(container.querySelectorAll('.digital-memory-node-list button').length, 9)
    await click('本轮唤起')
    assert.equal(container.querySelectorAll('.digital-memory-node-list button').length, 4)
    await click('重置演示')
    assert.equal(container.querySelectorAll('.digital-memory-node-list button').length, 8)
    assert.match(detail().textContent!, /小舟/)
  } finally {
    await act(async () => root.unmount()); container.remove(); await window.happyDOM.close()
  }
})
