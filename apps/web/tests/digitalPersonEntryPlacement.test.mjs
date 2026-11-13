import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'

test('digital person chat entry precedes the default workspace row outside its collapsed content',()=>{
 const layout=readFileSync(new URL('../src/components/Layout.tsx',import.meta.url),'utf8')
 assert.match(layout, /<div key=\{p.id\}>\s*\{p.is_default_workspace && <DigitalPersonSidebarEntry project=\{p\} \/>\}/)
 const expanded=layout.slice(layout.indexOf('{/* Workflow list + sessions under the selected project */}'))
 assert.equal(expanded.includes('<DigitalPersonSidebarEntry'),false)
})

test("default workspace chat does not mount the temporary digital person console",()=>{
 const page=readFileSync(new URL("../src/pages/ChatPage.tsx",import.meta.url),"utf8")
 assert.equal(page.includes("<DigitalPersonWorkspace"),false)
 assert.equal(page.includes("<DigitalPersonCompanion"),false)
 assert.ok(page.includes("<AssistantChatPanel"))
})
