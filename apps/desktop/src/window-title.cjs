function desktopWindowTitle(isPackaged, version) {
  return isPackaged ? `WorkStep ${version}` : 'WorkStep'
}

module.exports = { desktopWindowTitle }
