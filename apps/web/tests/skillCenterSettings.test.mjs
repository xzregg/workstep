import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import SkillCenterSettings from '../src/pages/SkillCenterSettings.tsx'
import { I18nProvider } from '../src/i18n/index.tsx'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const component = fs.readFileSync(path.join(root, 'src/pages/SkillCenterSettings.tsx'), 'utf8')
const settings = fs.readFileSync(path.join(root, 'src/pages/SettingsPage.tsx'), 'utf8')
const api = fs.readFileSync(path.join(root, 'src/api/client.ts'), 'utf8')

test('skill center is project-scoped with search, source filtering and rollback', () => {
  assert.match(component, /project\?\.id/)
  assert.match(component, /setSearch/)
  assert.match(component, /setSource/)
  assert.match(component, /setSkills\(previous\)/)
  assert.match(component, /role="switch"/)
  assert.match(component, /!skill\.valid/)
  assert.match(component, /selectedSkillIds/)
  assert.match(component, /selectAllFiltered/)
  assert.match(component, /batchSetEnabled/)
  assert.match(component, /gridTemplateColumns: '28px minmax\(0, 1fr\) 132px'/)
})

test('settings navigation and API expose the project skill center', () => {
  assert.match(settings, /activeSection === 'skills'/)
  assert.match(settings, /<SkillCenterSettings project=\{activeProject\}/)
  assert.match(api, /\/skills\/projects\//)
  assert.match(api, /\/skills\/rescan\?project_id=/)
  assert.match(api, /\/skills\/projects\/\$\{encodeURIComponent\(projectId\)\}\/batch/)
})

test('skill center renders with an active project without crashing', () => {
  const project = {
    id: 'project-1',
    name: 'Demo',
    path: '/tmp/demo',
    steps: {},
    workflows: [],
  }
  const html = renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(SkillCenterSettings, { project }),
    ),
  )
  assert.match(html, /Demo/)
  assert.match(html, /技能中心/)
})
