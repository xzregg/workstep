function parseVersion(value) {
  if (typeof value !== 'string') return null
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
  if (!match) return null
  return {
    core: match.slice(1, 4).map(Number),
    prerelease: match[4]?.split('.') ?? [],
  }
}

function comparePrerelease(left, right) {
  if (!left.length || !right.length) return left.length ? -1 : right.length ? 1 : 0
  const length = Math.max(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    if (left[index] === undefined) return -1
    if (right[index] === undefined) return 1
    if (left[index] === right[index]) continue
    const leftNumber = /^\d+$/.test(left[index]) ? Number(left[index]) : null
    const rightNumber = /^\d+$/.test(right[index]) ? Number(right[index]) : null
    if (leftNumber !== null && rightNumber !== null) return leftNumber > rightNumber ? 1 : -1
    if (leftNumber !== null) return -1
    if (rightNumber !== null) return 1
    return left[index] > right[index] ? 1 : -1
  }
  return 0
}

function shouldOfferUpdate(currentValue, downloadedValue) {
  const current = parseVersion(currentValue)
  const downloaded = parseVersion(downloadedValue)
  if (!current || !downloaded) return false
  for (let index = 0; index < current.core.length; index += 1) {
    if (downloaded.core[index] === current.core[index]) continue
    return downloaded.core[index] > current.core[index]
  }
  return comparePrerelease(downloaded.prerelease, current.prerelease) > 0
}

module.exports = { shouldOfferUpdate }
