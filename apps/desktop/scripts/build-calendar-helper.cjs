const path = require('node:path')
const fs = require('node:fs/promises')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
async function buildCalendarHelper(root = path.resolve(__dirname, '..'), architecture) {
  const output = path.join(root, 'build/calendar-helper')
  await fs.mkdir(path.dirname(output), { recursive: true })
  const target = architecture === 1 ? 'x86_64' : architecture === 3 ? 'arm64' : null
  await promisify(execFile)('xcrun', ['swiftc', '-O', '-swift-version', '5', ...(target?['-target',target+'-apple-macosx11.0']:[]),
    '-framework', 'EventKit', '-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', path.join(root, 'native/CalendarHelper-Info.plist'),
    path.join(root, 'native/CalendarHelper.swift'), '-o', output])
  return output
}
if (require.main === module) buildCalendarHelper().catch(error => { console.error(error.message); process.exitCode = 1 })
module.exports = { buildCalendarHelper }
