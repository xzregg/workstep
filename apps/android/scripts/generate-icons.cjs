// Use Chromium, as the website does, so SVG markers and gradients survive rasterization.
const fs = require('node:fs/promises')
const path = require('node:path')
const { execFile } = require('node:child_process')
const android = path.resolve(__dirname, '..')

if (!process.versions.electron) {
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const electron = require(require.resolve('electron', { paths: [path.resolve(android, '../desktop')] }))
  execFile(electron, [__filename, ...process.argv.slice(2)], { env }, (error, stdout, stderr) => {
    if (stdout) process.stdout.write(stdout)
    if (stderr) process.stderr.write(stderr)
    if (error) process.exitCode = 1
  })
} else {
  const { app, BrowserWindow } = require('electron')
  app.disableHardwareAcceleration()
  app.whenReady().then(async () => {
    const source = await fs.readFile(path.resolve(android, '../web/public/favicon.svg'), 'utf8')
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
    await window.loadURL('data:text/html,<html><body></body></html>')
    const variants = [
      // Legacy 48dp tile: same apparent logo size as the adaptive 72dp visible viewport.
      { name: 'app_icon', size: 512, logo: 512 * 60 / 72, background: true },
      // 108dp adaptive layer, with a 60dp SVG; its arrow tips fit inside the central 66dp safe circle.
      { name: 'app_icon_foreground', size: 432, logo: 240, background: false },
    ]
    for (const variant of variants) {
      const data = await window.webContents.executeJavaScript(`(async () => {
        const image = new Image(); image.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(source).toString('base64'))};
        await image.decode();
        const { size, logo, background } = ${JSON.stringify(variant)};
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d');
        if (background) {
          ctx.fillStyle = '#ffffff'; ctx.beginPath(); ctx.roundRect(0, 0, size, size, size / 5); ctx.fill();
        }
        ctx.drawImage(image, (size - logo) / 2, (size - logo) / 2, logo, logo);
        if (!background) {
          const pixels = ctx.getImageData(0, 0, size, size).data;
          for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
            if (pixels[(y * size + x) * 4 + 3] && Math.hypot(x + .5 - size / 2, y + .5 - size / 2) > size * 33 / 108) {
              throw new Error('Website logo exceeds Android adaptive icon safe circle');
            }
          }
        }
        return canvas.toDataURL('image/png');
      })()`)
      const png = Buffer.from(data.split(',')[1], 'base64')
      const target = path.join(android, 'app/src/main/res/drawable-nodpi', variant.name + '.png')
      if (process.argv.includes('--check')) {
        if (!png.equals(await fs.readFile(target))) throw new Error('Regenerate Android icon: ' + variant.name)
      } else {
        await fs.writeFile(target, png)
      }
    }
    console.log(process.argv.includes('--check') ? 'Android icons match website SVG' : 'Android icons generated from apps/web/public/favicon.svg')
    app.quit()
  }).catch(error => { console.error(error); app.exit(1) })
}
