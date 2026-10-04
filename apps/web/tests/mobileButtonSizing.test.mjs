import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const mobileCss = await readFile(new URL('../src/mobile.css', import.meta.url), 'utf8')
const gitCss = await readFile(new URL('../src/components/git/git.css', import.meta.url), 'utf8')
const executionCss = await readFile(new URL('../src/components/TaskExecutionAnalysis.css', import.meta.url), 'utf8')
const stepGraphCss = await readFile(new URL('../src/components/TaskStepProgressGraph.css', import.meta.url), 'utf8')
const mobileCheck = await readFile(new URL('../scripts/check-mobile.cjs', import.meta.url), 'utf8')

test('mobile visible buttons use one shared height', () => {
  assert.match(mobileCss, /--mobile-button-height:\s*32px/)
  assert.match(mobileCss, /--mobile-control-compact:\s*var\(--mobile-button-height\)/)
  assert.match(mobileCss, /--mobile-control-composer:\s*var\(--mobile-button-height\)/)
  assert.match(mobileCss, /--mobile-control-regular:\s*var\(--mobile-button-height\)/)
  assert.match(mobileCss, /--mobile-control-touch:\s*44px/)
  assert.match(mobileCss, /--mobile-control-menu:\s*44px/)
  assert.match(mobileCss, /--mobile-toolbar-control-height:\s*var\(--mobile-control-regular\)/)
  assert.match(mobileCss, /--mobile-control-font-size:\s*calc\(13px \* var\(--font-scale\)\)/)
  assert.match(mobileCss, /--mobile-control-icon-size:\s*16px/)
})

test('mobile form and sheet controls share height and typography', () => {
  assert.match(mobileCss, /input:not\(\[type="checkbox"\]\)[\s\S]*?select,[\s\S]*?\.ws-select\s*\{[^}]*height:\s*var\(--mobile-control-regular\)\s*!important[^}]*font-size:\s*var\(--mobile-control-font-size\)\s*!important/s)
  assert.match(mobileCss, /\.btn:not\(\.btn-icon\)\s*\{[^}]*font-size:\s*var\(--mobile-control-font-size\)\s*!important/s)
  assert.match(mobileCss, /\.mobile-sheet-body > button,[\s\S]*?\.mobile-sheet-body > select\s*\{[^}]*height:\s*var\(--mobile-control-regular\)\s*!important[^}]*padding:\s*0 12px\s*!important/s)
  assert.match(mobileCss, /\.mobile-sheet-body > button svg\s*\{[^}]*width:\s*var\(--mobile-control-icon-size\)\s*!important/s)
})

test('quota refresh keeps its round visual size on mobile', () => {
  assert.match(mobileCss, /\.chat-input-quota-refresh\s*\{[^}]*min-height:\s*0\s*;/s)
  assert.doesNotMatch(mobileCss, /\.chat-input-quota-refresh\s*,[^{}]*\{[^}]*min-height:\s*var\(--mobile-control-compact\)/s)
})

test('mobile workflow chrome uses explicit compact visual heights', () => {
  assert.match(mobileCss, /\.ai-flow-editor-mobile-header button\s*\{[^}]*height:\s*var\(--mobile-control-regular\)[^}]*min-height:\s*var\(--mobile-control-regular\)/s)
  assert.match(mobileCss, /\.flow-canvas-toolbar button,[\s\S]*?\{[^}]*height:\s*var\(--mobile-toolbar-control-height\)\s*!important[^}]*min-height:\s*var\(--mobile-toolbar-control-height\)\s*!important/s)
  assert.match(mobileCss, /\.flow-node-config-panel > div:first-child button\s*\{[^}]*height:\s*var\(--mobile-control-compact\)\s*!important[^}]*min-height:\s*var\(--mobile-control-compact\)\s*!important/s)
  assert.match(mobileCss, /\.flow-canvas-workspace \.react-flow__controls-button\s*\{[^}]*height:\s*var\(--mobile-control-compact\)\s*!important[^}]*min-height:\s*var\(--mobile-control-compact\)\s*!important/s)
})

test('mobile page-specific button rules consume the shared scale', () => {
  assert.match(gitCss, /\.git-page-header \.git-back-button[^}]*width:var\(--mobile-control-regular\)/s)
  assert.match(gitCss, /\.git-page-header \.git-settings-toggle[^}]*width:var\(--mobile-control-regular\)/s)
  assert.match(executionCss, /\.execution-analysis-controls button[^}]*min-height:\s*var\(--mobile-control-regular\)/s)
  assert.match(executionCss, /\.execution-gantt-lane > button[^}]*height:\s*var\(--mobile-control-regular\)/s)
  assert.match(stepGraphCss, /@media \(max-width: 1023px\)[\s\S]*\.task-step-progress-zoom button[^}]*width:\s*var\(--mobile-control-compact\)[^}]*min-height:\s*var\(--mobile-control-compact\)/)
})

test('new mobile button height rules cannot introduce one-off pixel sizes', () => {
  const allowedExceptions = /sidebar-add-button|chat-input-image-remove|button svg/
  for (const match of mobileCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = match[1].trim().replace(/\s+/g, ' ')
    if (!/button|\.btn|action|kebab|send|attach|entry/.test(selector)) continue
    if (allowedExceptions.test(selector)) continue
    assert.doesNotMatch(
      match[2],
      /(?:min-)?height:\s*(?:2[1-9]|3\d|4\d|50)px/,
      `${selector} must use a shared --mobile-control-* height`,
    )
  }
})

test('mobile QA checks representative buttons on every main surface', () => {
  for (const selector of [
    '.mobile-task-toolbar',
    '.task-detail-window',
    '.task-create-panel',
    '.flow-canvas-toolbar',
    '.flow-node-config-panel',
    '.assistant-chat-panel',
    '.settings-layout',
    '.git-page',
    '.mobile-sheet',
  ]) {
    assert.match(mobileCheck, new RegExp(selector.replaceAll('.', '\\.')))
  }
  assert.match(mobileCheck, /assertMobileButtonHeights/)
  assert.match(mobileCheck, /const standardHeight=32/)
  assert.doesNotMatch(mobileCheck, /const allowed=\[28,32,36,44,48\]/)
})
