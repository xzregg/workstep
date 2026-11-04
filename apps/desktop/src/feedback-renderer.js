/* global feedback */
const byId = id => document.getElementById(id)
let busy = false
function discardImage() {
  byId('preview').hidden = true
  byId('image-preview').replaceChildren()
}
async function perform(message, operation, success) {
  if (busy) return
  busy = true
  byId('status').textContent = message
  byId('status').dataset.busy = 'true'
  byId('error').hidden = true
  for (const button of document.querySelectorAll('button:not(#done)')) button.disabled = true
  try {
    await operation()
    byId('status').textContent = success
  } catch (error) {
    byId('status').textContent = '操作未完成，请重试。'
    byId('error').textContent = error.message || String(error)
    byId('error').hidden = false
  } finally {
    busy = false
    delete byId('status').dataset.busy
    for (const button of document.querySelectorAll('button')) button.disabled = false
  }
}
function copyText() {
  if (busy) return
  discardImage()
  byId('consent').hidden = true
  return perform('正在整理并复制错误摘要…', async () => {
    await feedback.copyText()
    byId('consent').hidden = false
  }, '反馈信息已复制，可直接粘贴发送。')
}
byId('retry').onclick = copyText
byId('capture').onclick = () => perform('正在截取当前 WorkStep 页面…', async () => {
  const image = await feedback.capture()
  const preview = document.createElement('img')
  preview.alt = '当前 WorkStep 页面截图'
  preview.src = image
  byId('image-preview').replaceChildren(preview)
  byId('preview').hidden = false
  byId('consent').hidden = true
}, '请检查截图，确认后再复制。复制图片会替换剪贴板文字。')
byId('copy-image').onclick = () => perform('正在复制截图…', () => feedback.copyImage(), '截图已复制，可粘贴发送。')
byId('cancel-image').onclick = () => perform('正在取消截图…', async () => {
  await feedback.clearImage()
  discardImage()
  byId('consent').hidden = false
}, '截图已取消，剪贴板内容未改变。')
byId('done').onclick = () => window.close()
document.addEventListener('keydown', event => { if (event.key === 'Escape') window.close() })
void copyText()
