import assert from 'node:assert/strict'
import test from 'node:test'
import {readFileSync} from 'node:fs'

test('digital person chat entry is pinned outside collapsed project content',()=>{
 const layout=readFileSync(new URL('../src/components/Layout.tsx',import.meta.url),'utf8')
 assert.match(layout, /className="layout-sidebar-pinned-entry"/)
 const expanded=layout.slice(layout.indexOf('{/* Workflow list + sessions under the selected project */}'))
 assert.equal(expanded.includes('<DigitalPersonSidebarEntry'),false)
})

test("default workspace chat does not mount the temporary digital person console",()=>{
 const page=readFileSync(new URL("../src/pages/ChatPage.tsx",import.meta.url),"utf8")
 assert.equal(page.includes("<DigitalPersonWorkspace"),false)
 assert.equal(page.includes("<DigitalPersonCompanion"),false)
 assert.ok(page.includes("<AssistantChatPanel"))
})

test('mobile digital person entry stays outside the scrolling project list', () => {
 const layout=readFileSync(new URL('../src/components/Layout.tsx',import.meta.url),'utf8')
 const pinned=layout.indexOf('className="layout-sidebar-pinned-entry"')
 const scroll=layout.indexOf('<div className="layout-sidebar-projects">')
 assert.ok(pinned > 0 && pinned < scroll)
 assert.match(layout.slice(pinned,scroll), /projects.filter\(project => project.is_default_workspace\)/)
 assert.match(layout.slice(pinned,scroll), /<DigitalPersonSidebarEntry key=\{project.id\} project=\{project\} \/>/)
})
