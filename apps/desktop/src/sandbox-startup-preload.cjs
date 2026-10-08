const { ipcRenderer } = require('electron')

window.addEventListener('DOMContentLoaded', () => {
  const invoke = action => ipcRenderer.invoke(`workstep:sandbox:startup:${action}`)
  document.getElementById('change-image').addEventListener('click', event => {
    const button = event.currentTarget
    button.disabled = true
    button.textContent = '正在扫描…'
    const picker = document.getElementById('image-picker')
    const select = document.getElementById('image-select')
    void invoke('dockerImages').then(result => {
      if (result.error) throw new Error(result.error)
      select.replaceChildren(new Option(result.images.length ? '请选择镜像' : '未发现兼容镜像', ''))
      for (const image of result.images) select.add(new Option(`${image.tags.join(', ') || image.id} (${Math.round(image.size / 1048576)} MiB)`, image.id))
      picker.classList.add('visible')
      button.textContent = '重新扫描'
    }).catch(error => {
      button.disabled = false
      button.textContent = '更换镜像'
      const detail = document.getElementById('error')
      detail.textContent = error instanceof Error ? error.message : String(error)
      document.getElementById('app').classList.add('failed')
    }).finally(() => { button.disabled = false })
  })
  document.getElementById('image-select').addEventListener('change', event => { document.getElementById('confirm-image').disabled = !event.currentTarget.value })
  document.getElementById('cancel-image').addEventListener('click', () => document.getElementById('image-picker').classList.remove('visible'))
  document.getElementById('confirm-image').addEventListener('click', event => {
    const button = event.currentTarget
    button.disabled = true; button.textContent = '正在切换…'
    void ipcRenderer.invoke('workstep:sandbox:startup:switchImage', document.getElementById('image-select').value).catch(error => {
      button.disabled = false; button.textContent = '使用所选镜像'
      const detail = document.getElementById('error'); detail.textContent = error instanceof Error ? error.message : String(error)
      document.getElementById('app').classList.add('failed')
    })
  })
  document.getElementById('open-logs').addEventListener('click', () => void invoke('openLogs'))
  document.getElementById('copy-logs').addEventListener('click', event => {
    const button = event.currentTarget
    void invoke('copyLogs').then(() => { button.textContent = '已复制' })
  })
  document.getElementById('view-logs').addEventListener('click', event => {
    const button = event.currentTarget
    const output = document.getElementById('logs')
    if (output.classList.contains('visible')) {
      output.classList.remove('visible')
      button.textContent = '查看日志'
      return
    }
    void invoke('readLogs').then(logs => {
      output.textContent = logs || '暂无日志'
      output.classList.add('visible')
      button.textContent = '收起日志'
    })
  })
  ipcRenderer.on('workstep:sandbox:startupStatus', (_event, status) => {
    const app = document.getElementById('app')
    const track = document.getElementById('track')
    document.getElementById('status').textContent = status.label
    document.getElementById('percent').textContent = status.progress === null ? '已停止' : `${status.progress}%`
    document.getElementById('error').textContent = status.error || ''
    app.classList.toggle('failed', status.phase === 'error')
    if (status.progress === null) {
      track.removeAttribute('data-value')
      track.style.removeProperty('--progress')
    } else {
      track.setAttribute('data-value', '')
      track.style.setProperty('--progress', `${status.progress}%`)
    }
  })
})
