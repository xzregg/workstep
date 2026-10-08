function validateGatewayOrigin(value) {
  const origin = new URL(value)
  const host = origin.hostname
  const loopback = host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' ||
    (/^127\.\d+\.\d+\.\d+$/.test(host) && host.split('.').every(part => Number(part) <= 255))
  const ipv4 = host.split('.').map(Number)
  const privateIpv4 = ipv4.length === 4 && ipv4.every(part => Number.isInteger(part) && part >= 0 && part <= 255) &&
    (ipv4[0] === 10 || (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31) || (ipv4[0] === 192 && ipv4[1] === 168))
  const privateIpv6 = /^\[(?:fc|fd)[0-9a-f:]+\]$/i.test(host)
  const privateGateway = loopback || privateIpv4 || privateIpv6
  if (origin.origin !== value || origin.username || origin.password || origin.port === '0' ||
    !(origin.protocol === 'https:' || (origin.protocol === 'http:' && privateGateway))) {
    throw new Error('Gateway origin requires HTTPS or private-network HTTP')
  }
  return origin
}

module.exports = { validateGatewayOrigin }
