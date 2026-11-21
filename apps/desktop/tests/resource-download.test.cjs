const assert = require('node:assert/strict')
const { createHash } = require('node:crypto')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const test = require('node:test')
const { downloadFile, discardDownload } = require('../src/resource-download.cjs')

for (const rangeSupported of [true, false]) {
  test(`resource download reuses its partial file when range support is ${rangeSupported}`, async t => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'workstep-resource-'))
    t.after(() => fs.rm(dir, { recursive: true, force: true }))
    const destination = path.join(dir, 'runtime.tar')
    const bytes = Buffer.from('abcdefghij')
    const asset = { url: 'https://example.test/archive', sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
    const stop = new AbortController()
    const broken = () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(bytes.subarray(0, 4)) },
    }), { headers: { 'Content-Length': '10' } })
    await assert.rejects(downloadFile(asset, destination, {
      fetchImpl: broken, signal: stop.signal, onProgress: ({ received }) => {
        if (received === 4) setTimeout(() => stop.abort(), 20)
      },
    }))
    assert.deepEqual(await fs.readdir(dir), [`runtime.tar.${asset.sha256}.partial`])
    let progress
    await downloadFile(asset, destination, {
      fetchImpl: async (_url, options) => {
        assert.equal(options.headers.Range, 'bytes=4-')
        return rangeSupported
          ? new Response(bytes.subarray(4), { status: 206, headers: { 'Content-Range': 'bytes 4-9/10' } })
          : new Response(bytes)
      },
      onProgress: value => { progress = value },
    })
    assert.deepEqual(progress, { received: 10, total: 10 })
    assert.deepEqual(await fs.readFile(destination), bytes)
    await downloadFile(asset, destination, {
      fetchImpl: async () => assert.fail('a verified archive is reused without a network request'),
    })
    await fs.writeFile(`${destination}.${asset.sha256}.partial`, 'stale')
    await discardDownload(asset, destination)
    assert.deepEqual(await fs.readdir(dir), ['runtime.tar'])
  })
}
