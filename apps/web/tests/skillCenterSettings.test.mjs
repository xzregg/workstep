import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const component = fs.readFileSync(path.join(root, 'src/pages/SkillCenterSettings.tsx'), 'utf8')
const settings = fs.readFileSync(path.join(root, 'src/pages/SettingsPage.tsx'), 'utf8')
const projectSettings = fs.readFileSync(path.join(root, 'src/components/ProjectSettingsPanel.tsx'), 'utf8')
const mobileCss = fs.readFileSync(path.join(root, 'src/mobile.css'), 'utf8')
const api = fs.readFileSync(path.join(root, 'src/api/project.ts'), 'utf8')

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

test('project settings navigation and API expose the project skill center', () => {
  assert.doesNotMatch(settings, /activeSection === 'skills'/)
  assert.doesNotMatch(settings, /<SkillCenterSettings/)
  assert.match(projectSettings, /key: 'skills'/)
  assert.match(projectSettings, /<SkillCenterSettings project=\{project\} embedded/)
  assert.match(api, /\/skills\/projects\//)
  assert.match(api, /\/skills\/rescan\?project_id=/)
  assert.match(api, /\/skills\/projects\/\$\{encodeURIComponent\(projectId\)\}\/batch/)
})

test('mobile skill center hides the project summary card', () => {
  assert.match(component, /className="skill-center-project-summary"/)
  assert.match(mobileCss, /\.skill-center-project-summary\s*\{\s*display:\s*none;/)
})
