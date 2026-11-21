const fs = require('node:fs/promises')
const { createReadStream, createWriteStream } = require('node:fs')
const { createHash } = require('node:crypto')
const { Readable, Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')

function partialPath(asset, destination) {
  if (!/^[a-f0-9]{64}$/.test(asset.sha256)) throw new Error('Invalid download checksum')
  return `${destination}.${asset.sha256}.partial`
}

function discardDownload(asset, destination) {
  return fs.rm(partialPath(asset, destination), { force: true })
}

async function fileSize(file) {
  try {
    const entry = await fs.lstat(file)
    if (!entry.isFile()) throw new Error('The resource download path must be a regular file')
    return entry.size
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return null
  }
}

async function matches(file, expected, signal) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash, { signal })
  return hash.digest('hex') === expected
}

const numberHeader = value => /^\d+$/.test(value ?? '') && Number.isSafeInteger(Number(value)) ? Number(value) : null

async function downloadFile(asset, destination, {
  onProgress, signal, fetchImpl = fetch, timeout = 600000, maxBytes = 1024 ** 3,
} = {}) {
  const part = partialPath(asset, destination)
  const { url, sha256, size } = asset
  if (typeof url !== 'string' || !url.startsWith('https://') ||
      (size != null && (!Number.isSafeInteger(size) || size < 0 || size > maxBytes))) {
    throw new Error('Invalid resource download manifest')
  }
  const deadline = AbortSignal.timeout(timeout)
  const active = signal ? AbortSignal.any([deadline, signal]) : deadline
  const previous = await fileSize(destination)
  if (previous != null && previous <= maxBytes && (size == null || previous === size) && await matches(destination, sha256, active)) {
    onProgress?.({ received: previous, total: previous })
    return
  }

  let offset = await fileSize(part) ?? 0
  if (offset > (size ?? maxBytes)) {
    await discardDownload(asset, destination)
    offset = 0
  }
  while (true) {
    active.throwIfAborted()
    const headers = { 'Accept-Encoding': 'identity' }
    if (offset) headers.Range = `bytes=${offset}-`
    const response = await fetchImpl(url, { headers, signal: active })
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('Content-Range') ?? '')
    const total = response.status === 206 ? numberHeader(range?.[3]) : numberHeader(response.headers.get('Content-Length'))
    const validRange = offset > 0 && total != null && total > offset && total <= maxBytes &&
      (size == null || size === total) && Number(range?.[1]) === offset && Number(range?.[2]) === total - 1
    if (offset && (response.status === 416 || (response.status === 206 && !validRange))) {
      await response.body?.cancel()
      if (response.status === 416 && (size == null || size === offset) && await matches(part, sha256, active)) {
        await fs.rename(part, destination)
        onProgress?.({ received: offset, total: offset })
        return
      }
      await discardDownload(asset, destination)
      offset = 0
      continue
    }
    if (!response.body || (response.status !== 200 && !(response.status === 206 && validRange)) ||
        (response.headers.get('Content-Encoding') ?? 'identity').toLowerCase() !== 'identity' ||
        (total != null && (total > maxBytes || (size != null && total !== size)))) {
      await response.body?.cancel()
      throw new Error(`Invalid resource download response (${response.status})`)
    }
    const start = response.status === 206 ? offset : 0
    let received = start
    const expectedBytes = size ?? total
    let oversized = false
    const meter = new Transform({ transform(chunk, _encoding, callback) {
      received += chunk.length
      if (received > (expectedBytes ?? maxBytes)) {
        oversized = true
        callback(new Error('Resource size mismatch'))
        return
      }
      onProgress?.({ received, total: expectedBytes })
      callback(null, chunk)
    } })
    try {
      await pipeline(Readable.fromWeb(response.body), meter,
        createWriteStream(part, { flags: start ? 'a' : 'w', mode: 0o600 }), { signal: active })
    } catch (error) {
      if (oversized) await discardDownload(asset, destination)
      throw error
    }
    if (expectedBytes != null && received !== expectedBytes) throw new Error('Incomplete resource download')
    if (await matches(part, sha256, active)) {
      await fs.rename(part, destination)
      onProgress?.({ received, total: expectedBytes ?? received })
      return
    }
    await discardDownload(asset, destination)
    if (!start) throw new Error('Resource download verification failed')
    offset = 0
  }
}

module.exports = { downloadFile, discardDownload }
