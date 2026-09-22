import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import EngineInstallProgress from '../src/components/EngineInstallProgress.tsx'
import { I18nProvider } from '../src/i18n/index.tsx'

const render = (props: Parameters<typeof EngineInstallProgress>[0]) => renderToStaticMarkup(
  <I18nProvider><EngineInstallProgress {...props} /></I18nProvider>,
)

test('download percentage is calculated only from measured bytes', () => {
  const html = render({ active: true, label: '下载主包', downloadedBytes: 524288, totalBytes: 1048576 })
  assert.match(html, /aria-valuenow="50"/)
  assert.match(html, /512 KiB/)
  assert.match(html, /1 MiB/)
})

test('unknown size and dependency installation never invent a percentage', () => {
  for (const props of [
    { active: true, label: '下载主包', downloadedBytes: 524288 },
    { active: true, label: '安装依赖' },
  ]) {
    const html = render(props)
    assert.doesNotMatch(html, /aria-valuenow/)
    assert.doesNotMatch(html, /\d+%/)
    assert.match(html, /role="status"/)
  }
})

test('completion stops the spinner; inactive progress is hidden', () => {
  const html = render({ active: false, completed: true, label: '完成' })
  assert.match(html, /aria-valuenow="100"/)
  assert.doesNotMatch(html, /class="spinner"/)
  assert.equal(render({ active: false, label: '安装' }), '')
})
