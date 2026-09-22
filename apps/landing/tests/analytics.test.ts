import { describe, expect, it } from 'vitest'
import { installWebAnalytics } from '../src/analytics'

describe('website analytics', () => {
  it('does not load a beacon without an explicit token', () => {
    const appended: unknown[] = []
    const documentLike = {
      createElement: () => ({ dataset: {} }),
      head: { appendChild: (value: unknown) => appended.push(value) },
    }

    expect(installWebAnalytics('', documentLike)).toBe(false)
    expect(appended).toHaveLength(0)
  })

  it('loads Cloudflare Web Analytics without cookies when configured', () => {
    const appended: Array<Record<string, unknown>> = []
    const documentLike = {
      createElement: () => ({ dataset: {} } as Record<string, unknown>),
      head: { appendChild: (value: Record<string, unknown>) => appended.push(value) },
    }

    expect(installWebAnalytics('public-token', documentLike)).toBe(true)
    expect(appended[0].src).toBe('https://static.cloudflareinsights.com/beacon.min.js')
    expect((appended[0].dataset as Record<string, string>).cfBeacon).toContain('public-token')
  })
})
