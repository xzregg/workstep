import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { transform } from 'lightningcss'
import config from '../vite.config'

test('production mobile CSS keeps classic width queries for older embedded browsers', async () => {
  const settings = await (config as Function)({command:'build',mode:'production'})
  const targets = Object.fromEntries(settings.build.cssTarget.map((target:string) => {
    const [,browser,version] = target.match(/^([a-z]+)([0-9]+)$/)!
    return [browser, Number(version) << 16]
  }))
  const css = readFileSync(new URL('../src/mobile.css', import.meta.url))
  const result = transform({filename:'mobile.css',code:css,minify:true,targets}).code.toString()
  assert.match(result, /max-width:1023px/)
  assert.doesNotMatch(result, /width\s*<=\s*1023px/)
})


test('running message shimmer gradients work without color-mix in embedded browsers', () => {
  const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8')
  for (const selector of ['.process-trace-thinking-label.is-shimmer', '.plan-label::before', '.llm-tool-call-summary.is-shimmer']) {
    const start = css.indexOf(selector + ' {')
    assert.ok(start >= 0, selector)
    const rule = css.slice(start, css.indexOf('}', start) + 1)
    assert.match(rule, /background: linear-gradient\(/)
    assert.doesNotMatch(rule, /color-mix\(/, selector + ' must keep transparent text backed by a compatible gradient')
    assert.match(rule, /animation:|transition:/)
  }
})
