import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { JSDOM } from 'jsdom'
import { AdminListStatus } from '../src/AdminListStatus'

test('project list shows a spinner only while loading', () => {
  const css = readFileSync(new URL('../src/gateway.css', import.meta.url), 'utf8')
  const pseudoSelectors = [...css.matchAll(/([^{}]+)::before\s*\{[^{}]*animation:\s*gateway-project-loading[^{}]*\}/g)]
    .map(match => match[1].trim())
  for (const loading of [true, false]) {
    const dom = new JSDOM(`<section class="gateway-projects-page">${renderToStaticMarkup(
      <AdminListStatus loading={loading} label="正在加载项目…" />,
    )}</section>`)
    const status = dom.window.document.querySelector('[role="status"]')!
    assert.equal(pseudoSelectors.some(selector => status.matches(selector)), false,
      'shared status must not receive a permanent or duplicate CSS spinner')
    assert.equal(status.querySelectorAll('.gateway-spinner').length, loading ? 1 : 0)
    dom.window.close()
  }
})
