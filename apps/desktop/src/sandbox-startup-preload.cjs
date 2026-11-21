const { ipcRenderer } = require('electron')

const CHANNEL = 'workstep:sandbox:startup:'
const IMAGES_PER_PAGE = 3
const LOG_PREVIEW_LINES = 8

window.addEventListener('DOMContentLoaded', () => {
  const element = id => document.getElementById(id)
  const invoke = (action, ...args) => ipcRenderer.invoke(CHANNEL + action, ...args)
  const steps = [...element('steps').children]
  const views = ['startup', 'logs', 'images']
  let status = { phase: 'idle', step: 'config' }
  let view = 'startup'
  let viewVersion = 0
  let images = []
  let imagePage = 0
  let selected = ''
  let scanning = false
  let switching = false
  let logsBusy = false

  function showView(next, focus) {
    view = next
    viewVersion += 1
    for (const name of views) element(name + '-view').hidden = name !== next
    const target = focus || element(next + '-view').querySelector('[data-back]')
    target?.focus()
  }

  function showStartup() {
    const focus = view === 'logs'
      ? element(status.phase === 'error' ? 'view-failure-logs' : 'view-logs')
      : element('change-image')
    showView('startup', focus)
  }

  function setFeedback(id, message, error = false) {
    const output = element(id)
    const content = output.lastElementChild || output
    content.textContent = message
    output.toggleAttribute('data-error', error)
    if (content !== output) content.classList.add('single-line')
    content.title = message
  }

  function renderStartup() {
    const failed = status.phase === 'error'
    const currentStep = steps.findIndex(row => row.dataset.step === status.step)
    steps.forEach((row, index) => {
      const state = status.phase === 'running' || index < currentStep ? 'done'
        : index > currentStep ? 'waiting' : failed ? 'failed' : 'active'
      if (row.dataset.state === state) return
      row.dataset.state = state
      if (state === 'active' || state === 'failed') row.setAttribute('aria-current', 'step')
      else row.removeAttribute('aria-current')
      row.lastElementChild.textContent = { done: '已完成', waiting: '等待中', failed: '失败', active: '进行中' }[state]
    })
    element('view-logs').hidden = failed
    element('failure').hidden = !failed
    element('error').textContent = (status.error || '沙箱启动失败').split(/\r?\n/, 1)[0]
    element('error').title = status.error || ''
    element('recovery').hidden = !status.recovery
    const image = element('current-image')
    const label = images.find(item => item.id === status.image?.id)?.tags[0] || status.image?.label || '未配置'
    image.textContent = label
    image.title = label
  }

  function renderImages() {
    const options = element('image-options')
    const first = imagePage * IMAGES_PER_PAGE
    const visible = images.slice(first, first + IMAGES_PER_PAGE)
    options.replaceChildren(...visible.map(image => {
      const label = document.createElement('label')
      label.className = 'option'
      const radio = document.createElement('input')
      radio.type = 'radio'
      radio.name = 'image'
      radio.value = image.id
      radio.checked = image.id === selected
      radio.disabled = scanning || switching
      const text = document.createElement('span')
      const name = document.createElement('span')
      name.className = 'mono single-line'
      name.textContent = image.tags[0] || image.id
      name.title = image.tags.join(', ') || image.id
      text.append(name)
      if (image.id === status.image?.id) {
        const current = document.createElement('small')
        current.textContent = '当前使用'
        text.append(current)
      }
      const size = document.createElement('small')
      size.textContent = image.size >= 1073741824
        ? `${(image.size / 1073741824).toFixed(2)} GiB` : `${Math.round(image.size / 1048576)} MiB`
      label.append(radio, text, size)
      return label
    }))
    options.hidden = !visible.length
    const pageCount = Math.ceil(images.length / IMAGES_PER_PAGE)
    element('image-pager').hidden = pageCount < 2
    element('image-page').textContent = `${imagePage + 1} / ${pageCount}`
    element('previous-images').disabled = scanning || switching || imagePage === 0
    element('next-images').disabled = scanning || switching || imagePage >= pageCount - 1
    element('scan-images').disabled = scanning || switching
    for (const button of element('images-view').querySelectorAll('[data-back]')) button.disabled = switching
    updateConfirm()
  }

  function updateConfirm() {
    element('confirm-image').disabled = scanning || switching || !selected ||
      (selected === status.image?.id && status.phase !== 'error')
  }

  async function scanImages() {
    if (scanning) return
    scanning = true
    element('images-feedback').classList.add('busy')
    setFeedback('images-feedback', '正在扫描本地 Docker…')
    renderImages()
    try {
      const result = await invoke('dockerImages')
      if (result.error) throw new Error(result.error)
      images = result.images
      const current = images.findIndex(image => image.id === status.image?.id)
      selected = current < 0 ? '' : images[current].id
      imagePage = current < 0 ? 0 : Math.floor(current / IMAGES_PER_PAGE)
      setFeedback('images-feedback', images.length ? '' : '未发现兼容的本地 Docker 镜像。')
    } catch (error) {
      images = []
      selected = ''
      imagePage = 0
      setFeedback('images-feedback', error.message, true)
    } finally {
      scanning = false
      element('images-feedback').classList.remove('busy')
      renderImages()
      renderStartup()
    }
  }

  function renderLogPreview(logs, error) {
    const lines = logs.split(/\r?\n/).filter(line => line.trim())
    const preview = lines.slice(-(LOG_PREVIEW_LINES - Number(Boolean(error))))
    if (error) preview.unshift(error.replace(/\s+/g, ' '))
    element('logs').replaceChildren(...(preview.length ? preview : ['暂无日志']).map(line => {
      const row = document.createElement('div')
      row.className = 'single-line'
      row.textContent = line
      return row
    }))
    setFeedback('logs-feedback', lines.length ? '日志预览。完整日志可复制或从日志目录打开。' : '')
  }

  async function showLogs() {
    showView('logs')
    const version = viewVersion
    element('logs').textContent = '正在读取日志…'
    setFeedback('logs-feedback', '')
    try {
      const logs = await invoke('readLogs')
      if (viewVersion === version) renderLogPreview(logs, status.error)
    } catch (error) {
      if (viewVersion === version) {
        element('logs').textContent = '无法读取日志。'
        setFeedback('logs-feedback', error.message, true)
      }
    }
  }

  async function runLogAction(action) {
    if (logsBusy) return
    logsBusy = true
    const version = viewVersion
    try {
      await invoke(action)
      if (viewVersion === version) setFeedback('logs-feedback', action === 'copyLogs' ? '已复制日志。' : '已打开日志目录。')
    } catch (error) {
      if (viewVersion === version) setFeedback('logs-feedback', error.message, true)
    } finally {
      logsBusy = false
    }
  }

  for (const id of ['view-logs', 'view-failure-logs']) element(id).addEventListener('click', showLogs)
  for (const button of document.querySelectorAll('[data-back]')) button.addEventListener('click', showStartup)
  element('copy-logs').addEventListener('click', () => void runLogAction('copyLogs'))
  element('open-logs').addEventListener('click', () => void runLogAction('openLogs'))
  element('change-image').addEventListener('click', () => { showView('images'); void scanImages() })
  element('scan-images').addEventListener('click', scanImages)
  for (const [id, offset] of [['previous-images', -1], ['next-images', 1]]) {
    element(id).addEventListener('click', () => {
      imagePage += offset
      renderImages()
      if (element(id).disabled) element(offset < 0 ? 'next-images' : 'previous-images').focus()
    })
  }
  element('image-options').addEventListener('change', event => {
    selected = event.target.value
    updateConfirm()
  })
  element('confirm-image').addEventListener('click', async () => {
    switching = true
    setFeedback('images-feedback', '正在切换…')
    element('images-feedback').classList.add('busy')
    renderImages()
    try {
      await invoke('switchImage', selected)
      showStartup()
    } catch (error) {
      setFeedback('images-feedback', error.message, true)
    } finally {
      switching = false
      element('images-feedback').classList.remove('busy')
      renderImages()
    }
  })
  for (const button of element('recovery').querySelectorAll('[data-recovery]')) {
    button.addEventListener('click', () => void invoke('recover', button.dataset.recovery).catch(error => {
      element('error').textContent = error.message
    }))
  }
  ipcRenderer.on('workstep:sandbox:startupStatus', (_event, next) => {
    status = next
    renderStartup()
    if (view === 'images') updateConfirm()
  })
  renderStartup()
})
