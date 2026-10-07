// Render the web favicon once, then encode desktop icon formats from it.
const fs = require('node:fs/promises')
const path = require('node:path')
const { execFile } = require('node:child_process')
const desktop = path.resolve(__dirname, '..')

if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  execFile(require('electron'), [__filename], { env }, (error, stdout, stderr) => {
    if (stdout) process.stdout.write(stdout)
    if (stderr) process.stderr.write(stderr)
    if (error) process.exitCode = 1
  })
} else {
  const { app, BrowserWindow, nativeImage } = require('electron')
  app.disableHardwareAcceleration()
  app.whenReady().then(async () => {
    const source = await fs.readFile(path.resolve(desktop, '../web/public/favicon.svg'), 'utf8')
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
    await window.loadURL('data:text/html,<html><body></body></html>')
    const data = await window.webContents.executeJavaScript(`(async () => {
      const image = new Image(); image.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(source).toString('base64'))};
      await image.decode(); const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1024;
      canvas.getContext('2d').drawImage(image, 0, 0, 1024, 1024); return canvas.toDataURL('image/png');
    })()`)
    const image = nativeImage.createFromDataURL(data)
    const build = path.join(desktop, 'build'), pngs = new Map()
    await fs.mkdir(path.join(build, 'icons'), { recursive: true })
    await fs.writeFile(path.join(build, 'app-icon.svg'), source)
    for (const size of [16, 32, 48, 64, 128, 256, 512, 1024]) {
      const png = image.resize({ width: size, height: size, quality: 'best' }).toPNG()
      pngs.set(size, png)
      await fs.writeFile(path.join(build, 'icons', `${size}x${size}.png`), png)
    }
    // Modern Windows ICO supports PNG-encoded entries up to 256px.
    const sizes = [16, 32, 48, 64, 128, 256], header = Buffer.alloc(6 + sizes.length * 16)
    header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4)
    let offset = header.length
    sizes.forEach((size, index) => {
      const entry = 6 + index * 16, png = pngs.get(size)
      header[entry] = header[entry + 1] = size === 256 ? 0 : size
      header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6)
      header.writeUInt32LE(png.length, entry + 8); header.writeUInt32LE(offset, entry + 12)
      offset += png.length
    })
    await fs.writeFile(path.join(build, 'icon.ico'), Buffer.concat([header, ...sizes.map(size => pngs.get(size))]))
    // Retina-capable ICNS stores its 256/512/1024px representations as PNG.
    const chunks = [[256, 'ic08'], [512, 'ic09'], [1024, 'ic10']].map(([size, type]) => {
      const png = pngs.get(size), chunk = Buffer.alloc(8)
      chunk.write(type); chunk.writeUInt32BE(png.length + 8, 4)
      return Buffer.concat([chunk, png])
    })
    const icns = Buffer.alloc(8); icns.write('icns'); icns.writeUInt32BE(8 + chunks.reduce((total, chunk) => total + chunk.length, 0), 4)
    await fs.writeFile(path.join(build, 'icon.icns'), Buffer.concat([icns, ...chunks]))
    console.log('Desktop icons generated from apps/web/public/favicon.svg')
    app.quit()
  }).catch(error => { console.error(error); app.exit(1) })
}
