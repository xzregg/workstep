function attachHideOnClose(window, isQuitting, onHide = () => {}) {
  window.on('close', event => {
    if (isQuitting()) return
    event.preventDefault()
    onHide()
    window.hide()
  })
  return window
}

function createGracefulQuit({ stop, quit, onStart = () => {}, onError = () => {} }) {
  let ready = false
  let pending = null
  return event => {
    onStart()
    if (ready) return
    event.preventDefault()
    if (pending) return
    pending = Promise.resolve()
      .then(stop)
      .catch(onError)
      .then(() => {
        ready = true
        quit()
      })
      .finally(() => { pending = null })
  }
}

module.exports = { attachHideOnClose, createGracefulQuit }
