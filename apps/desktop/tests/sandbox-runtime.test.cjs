const test = require('node:test')
const assert = require('node:assert/strict')
const { extractWindowsZip } = require('../src/sandbox-runtime.cjs')

test('Windows ZIP extraction uses Unicode APIs and literal environment paths, not ANSI tar', async () => {
  const archive = "C:\\中文 用户's path\\runtime.zip"
  const destination = "C:\\中文 用户's path\\stage"
  let invocation
  await extractWindowsZip(archive, destination, async (...args) => { invocation = args })
  const [file, args, options] = invocation
  assert.equal(file, 'powershell.exe')
  assert(args.includes('-NonInteractive') && args.includes('-NoProfile'))
  assert.equal(options.env.WORKSTEP_ZIP_ARCHIVE, archive)
  assert.equal(options.env.WORKSTEP_ZIP_DESTINATION, destination)
  const script = args.at(-1)
  assert(!script.includes(archive) && !script.includes(destination))
  assert.match(script, /ZipFile.*OpenRead/)
  assert.match(script, /GetFullPath/)
  assert.match(script, /OrdinalIgnoreCase/)
  assert.match(script, /ExternalAttributes/)
  assert.match(script, /ExtractToDirectory/)
  assert(script.indexOf('ExtractToDirectory') > script.indexOf('foreach'))
})
