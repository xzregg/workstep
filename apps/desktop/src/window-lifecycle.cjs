function attachHideOnClose(window, isQuitting, onHide = () => {}) {
  window.on('close', event => {
    if (isQuitting()) return
    event.preventDefault()
    onHide()
    window.hide()
  })
  return window
}

module.exports = { attachHideOnClose }
