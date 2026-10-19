/** Minimal Node.js website login example. Run manually; no external packages. */
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'

const gateway = new URL(process.env.GATEWAY_URL || 'https://gateway.example.com')
const callback = new URL(process.env.CALLBACK_URL || 'http://localhost:8080/callback')
const port = Number(process.env.PORT || 8080)
const pending = new Map()
const random = () => randomBytes(32).toString('base64url')
const cookieName = 'workstep_login_demo'

if (!['https:', 'http:'].includes(gateway.protocol) || !['https:', 'http:'].includes(callback.protocol)) {
  throw Error('Gateway and callback must use HTTP or HTTPS')
}

const server = createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('Referrer-Policy', 'no-referrer')
  const url = new URL(req.url, callback.origin)
  const reply = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(body)
  }
  if (req.method !== 'GET') return reply(405, 'Method not allowed')
  if (url.pathname === '/done') return reply(200, '用户信息兑换完成。此示例未建立业务登录会话，请在回调中接入本系统账号与会话。')
  // Prune abandoned attempts; production should use its existing session store.
  for (const [state, attempt] of pending) if (attempt.expires <= Date.now()) pending.delete(state)
  const browser = (req.headers.cookie || '').split(';').map(value => value.trim())
    .find(value => value.startsWith(cookieName + '='))?.slice(cookieName.length + 1)

  if (url.pathname === '/login') {
    if (pending.size >= 1000) return reply(429, '请稍后重试')
    const browserSession = /^[A-Za-z0-9_-]{43}$/.test(browser || '') ? browser : random()
    const state = random()
    const requestId = random()
    pending.set(state, { browser: browserSession, requestId, expires: Date.now() + 10 * 60_000 })
    res.setHeader('Set-Cookie', `${cookieName}=${browserSession}; HttpOnly; SameSite=Lax; Path=/; Max-Age=600${callback.protocol === 'https:' ? '; Secure' : ''}`)
    const login = new URL('/auth/authorize', gateway)
    login.search = new URLSearchParams({ callback: callback.href, state, request_id: requestId }).toString()
    res.writeHead(302, { Location: login.href })
    return res.end()
  }

  if (url.pathname !== callback.pathname) return reply(404, '请访问 /login 开始登录')
  if (url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length !== 1) {
    return reply(400, '回调参数无效，请重新登录')
  }
  const state = url.searchParams.get('state')
  const code = url.searchParams.get('code')
  const attempt = pending.get(state)
  if (!code || !attempt || !browser || attempt.browser !== browser || attempt.expires <= Date.now()) {
    return reply(400, '登录请求不匹配或已过期，请重新登录')
  }
  pending.delete(state)
  try {
    const result = await fetch(new URL('/api/auth/exchange', gateway), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, request_id: attempt.requestId }), signal: AbortSignal.timeout(10_000),
    })
    if (!result.ok) return reply(result.status, '登录兑换失败，请重新发起登录；若持续失败请联系管理员')
    const { user } = await result.json()
    // Replace this with your application's account association and session creation.
    // Use gateway.origin + user.id as the identity; never auto-link by display name.
    if (!user?.id || typeof user.display_name !== 'string') throw Error('Invalid user response')
    // The demo displays no personal information in a query string or log.
    res.writeHead(303, { Location: '/done' })
    res.end()
  } catch {
    reply(502, '无法完成登录，请重新发起登录')
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`登录示例：http://localhost:${port}/login（需先登记 CALLBACK_URL）`)
})
