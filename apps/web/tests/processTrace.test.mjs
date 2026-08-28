import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../src/components/ProcessTrace.tsx', import.meta.url), 'utf8')
const messageTimelineSource = await readFile(new URL('../src/components/MessageTimeline.tsx', import.meta.url), 'utf8')
const messageMetaBarSource = await readFile(new URL('../src/components/MessageMetaBar.tsx', import.meta.url), 'utf8')
const styles = await readFile(new URL('../src/index.css', import.meta.url), 'utf8')
const subagentSource = await readFile(
  new URL('../src/components/SubagentTimelineItem.tsx', import.meta.url),
  'utf8',
)

test('thinking process renders ordered reasoning timeline items', () => {
  assert.match(source, /item\.type === 'thinking'/)
  assert.doesNotMatch(source, /process-trace-tools-group/)
})

test('thinking process expands inline instead of opening a popup', () => {
  assert.match(source, /<details[\s\S]*className="process-trace-session"/)
  assert.doesNotMatch(source, /document\.addEventListener\('mousedown'/)
  assert.doesNotMatch(source, /processTracePanelAvailableWidth/)
  assert.doesNotMatch(
    styles,
    /\.process-trace-compact \.process-trace-body\s*\{[\s\S]*?position:\s*absolute/,
  )
})

test('summary includes executed commands only when at least one tool ran', () => {
  assert.match(source, /event\.type === 'tool_use'/)
  assert.match(source, /commandCount > 0 && t\('trace\.commandCount'/)
})

test('process stream stays expanded except for lazy persisted details', () => {
  assert.match(source, /useState\(!detailsAvailable \|\| detailsLoaded\)/)
  assert.match(source, /if \(running && !detailsAvailable\) setOpen\(true\)/)
  assert.doesNotMatch(source, /setOpen\(running\)/)
  assert.match(source, /<details[\s\S]*className="process-trace-session"[\s\S]*open=\{open\}/)
  assert.doesNotMatch(source, /!running && !stopped && t\('trace\.commandCount'/)
})

test('persisted process details load only when their disclosure is opened', () => {
  assert.match(source, /detailsAvailable\?:\s*boolean/)
  assert.match(source, /detailsLoaded\?:\s*boolean/)
  assert.match(source, /onLoadDetails\?:\s*\(\) => void/)
  assert.match(source, /if \(nextOpen && detailsAvailable && !detailsLoaded && !detailsLoading\)/)
  assert.match(source, /onLoadDetails\?\.\(\)/)
  assert.match(messageMetaBarSource, /detailsAvailable=\{eventDetail\?\.available\}/)
})

test('process stream renders thinking and tools from one ordered timeline', () => {
  assert.match(source, /buildMessageTimeline\(events\)/)
  assert.match(source, /item\.type === 'thinking'/)
  assert.match(source, /<ToolTimelineItem/)
  assert.doesNotMatch(messageTimelineSource, /timeline\.filter\(\(item\) => item\.type !== 'text'\)/)
})

test('compact process stream uses the available message width', () => {
  const compactRule = styles.match(/\.process-trace-compact\s*\{([\s\S]*?)\}/)?.[1] || ''
  assert.doesNotMatch(compactRule, /620px/)
  assert.match(compactRule, /width:\s*100%/)
  assert.match(compactRule, /max-width:\s*100%/)
})

test('message metadata shares the summary row without narrowing the process body', () => {
  assert.match(source, /summaryMeta\?:\s*ReactNode/)
  assert.match(source, /<summary>[\s\S]*\{summaryMeta\}[\s\S]*<\/summary>/)
  assert.match(messageMetaBarSource, /summaryMeta=\{/)
  assert.match(messageMetaBarSource, /className="message-meta-details"/)
})

test('message metadata shows compacted status without exposing the summary body', () => {
  assert.match(messageMetaBarSource, /hasCompactedEvent\(events\)/)
  assert.match(messageMetaBarSource, /t\('meta\.compactedTitle'\)/)
  assert.match(messageMetaBarSource, /t\('meta\.compacted'\)/)
  assert.doesNotMatch(messageMetaBarSource, /event\?\.value\?\.summary/)
})

test('each thinking segment has its own character-count disclosure', () => {
  assert.match(source, /function ThinkingTimelineItem/)
  assert.match(source, /className="process-trace-thinking-block"/)
  assert.match(source, /trace\.thoughtCharacters/)
})

test('thinking disclosure arrow sits beside the character-count label', () => {
  assert.match(
    source,
    /trace\.thoughtCharacters[\s\S]*process-trace-chevron[\s\S]*MessageCopyButton/,
  )
})

test('thinking copy action appears only while the thinking block is hovered or focused', () => {
  assert.match(source, /className="process-trace-thinking-copy"/)
  assert.match(
    styles,
    /\.process-trace-thinking-copy\s*\{[\s\S]*?opacity:\s*0;[\s\S]*?\}/,
  )
  assert.match(
    styles,
    /\.process-trace-thinking-block:hover[\s\S]*\.process-trace-thinking-copy[\s\S]*\.process-trace-thinking-block:focus-within[\s\S]*\.process-trace-thinking-copy\s*\{[\s\S]*?opacity:\s*1;/,
  )
})

test('active thinking output follows new text until the reader scrolls upward', () => {
  assert.match(source, /useLayoutEffect\(\(\) => \{[\s\S]*thinkingRef\.current[\s\S]*scrollTop = target[\s\S]*\}, \[active, content, open\]\)/)
  assert.match(source, /onWheelCapture=\{[\s\S]*shouldPauseConversationFollow/)
  assert.match(source, /isNearConversationBottom\([\s\S]*followRef\.current = true/)
})

test('process stream renders subagent lifecycle items alongside tools', () => {
  assert.match(source, /SubagentTimelineItem/)
  assert.match(source, /item\.type === 'subagent'/)
  assert.match(source, /messageRunning=\{running\}/)
  assert.match(subagentSource, /task-status-spinner/)
  assert.match(subagentSource, /trace\.subagentRunning/)
  assert.match(subagentSource, /trace\.subagentFailed/)
  assert.match(subagentSource, /trace\.subagentSummary/)
})
