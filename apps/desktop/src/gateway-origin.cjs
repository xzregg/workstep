function validateGatewayOrigin(value) {
  const origin = new URL(value)
  const host = origin.hostname
  const loopback = host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' ||
    (/^127\.\d+\.\d+\.\d+$/.test(host) && host.split('.').every(part => Number(part) <= 255))
  if (origin.origin !== value || origin.username || origin.password || origin.port === '0' ||
    !(origin.protocol === 'https:' || (origin.protocol === 'http:' && loopback))) {
    throw new Error('Gateway origin requires HTTPS or loopback HTTP')
  }
  return origin
}

module.exports = { validateGatewayOrigin }
