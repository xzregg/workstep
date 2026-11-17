import assert from 'node:assert/strict'
import test from 'node:test'
import { encodePermissionSelection, nativePermissionMenu, permissionSelection } from '../src/utils/enginePermissions'
const fields = [
  { id: 'sandbox', name: '沙箱', type: 'select' as const, currentValue: 'workspace', options: [{ value: 'workspace', name: '工作区' }, { value: 'read', name: '只读' }] },
  { id: 'approval', name: '审批', type: 'select' as const, currentValue: 'default', options: [{ value: 'default', name: '原生默认' }, { value: 'ask', name: '询问' }] },
]
test('inherit and explicit native default remain distinct after serialization', () => {
  const stored = encodePermissionSelection('custom', { approval: 'default' })
  const menu = nativePermissionMenu('custom', fields, stored, '跟随引擎设置')
  assert.equal(menu.options[0].selected, false)
  assert.equal(menu.label, '原生默认')
  assert.equal(menu.options.filter(option => option.selected).length, 0)
  assert.equal(permissionSelection('other', stored), null)
})
test('changing one native field preserves the other explicit field', () => {
  const stored = encodePermissionSelection('custom', { approval: 'ask' })
  const menu = nativePermissionMenu('custom', fields, stored, '跟随引擎设置', 'sandbox')
  const read = menu.options.find(option => option.label === '只读')!
  assert.deepEqual(permissionSelection('custom', read.value), { approval: 'ask', sandbox: 'read' })
  assert.equal(nativePermissionMenu('custom', fields, '', '跟随引擎设置').options[1].description, '工作区')
})
test('engines without native declarations offer inheritance only', () => {
  assert.equal(nativePermissionMenu('custom', [], '', '跟随引擎设置').options.length, 1)
})


test('localized native choices have concise, distinct descriptions', async () => {
  const { createT, zhCNT } = await import('../src/i18n')
  const english = (await import('../src/i18n/locales/en-US')).enUS
  const field = [{ id: 'permission_mode', name: 'permission_mode', type: 'select' as const, currentValue: 'manual', description: 'same long field help', options: [
    {value:'manual',name:'manual'}, {value:'acceptEdits',name:'acceptEdits'}, {value:'plan',name:'plan'},
  ] }]
  const cn = nativePermissionMenu('claude', field, '', '跟随引擎', null, zhCNT)
  assert.deepEqual(cn.options.slice(1).map(option => option.label), ['标准审批', '自动编辑'])
  assert.equal(new Set(cn.options.slice(1).map(option => option.description)).size, 2)
  assert.ok(cn.options.every(option => option.description !== 'same long field help'))
  const en = nativePermissionMenu('claude', field, '', 'Follow engine', null, createT(english))
  assert.deepEqual(en.options.slice(1).map(option => option.label), ['Standard approval', 'Auto-edit'])
})

test('Pydantic hides compatibility options even when served by an older daemon', () => {
  const menu = nativePermissionMenu('pydantic_ai', [{id:'permission_mode',name:'权限',type:'select',currentValue:'legacy',options:
    ['full','auto','read-only','legacy'].map(value => ({value,name:value}))}], '', '跟随引擎')
  assert.equal(menu.options.length, 4)
  assert.ok(!menu.options.some(option => option.label === 'legacy'))
})


test('older daemon settings also show only three Pydantic modes', async () => {
  const { visiblePermissionFields, permissionFormValues } = await import('../src/utils/permissionLabels')
  const fields = visiblePermissionFields('pydantic_ai', [{key:'sandbox',options:[]}, {key:'permission_mode',options:
    ['full','auto','read-only','legacy'].map(value => ({value}))}])
  assert.deepEqual(fields.map(field => field.key), ['permission_mode'])
  assert.deepEqual(fields[0].options?.map(option => option.value), ['full','auto','read-only'])
  assert.equal(permissionFormValues('pydantic_ai', {permission_mode:'legacy',sandbox:'read-only'}).permission_mode, 'read-only')
})


test('Codex is a single choice and new choices clear old hidden approval overrides', () => {
  const fields = [
    { id:'sandbox', name:'沙箱', type:'select' as const, currentValue:'workspace-write', options:
      ['', 'read-only','workspace-write','danger-full-access'].map(value => ({value,name:value})) },
    { id:'approval_mode',name:'审批',type:'select' as const,currentValue:'auto_review',options:[{value:'auto_review',name:'auto_review'}] },
  ]
  const saved = encodePermissionSelection('codex_sdk', {sandbox:'workspace-write', approval_mode:'auto_review'})
  const menu = nativePermissionMenu('codex_sdk',fields,saved,'跟随引擎')
  assert.equal(menu.options.length,4)
  assert.equal(menu.options.filter(option=>option.selected).length,1)
  assert.ok(menu.options.every(option=>!option.keepOpen))
  const full = menu.options.at(-1)!
  assert.deepEqual(permissionSelection('codex_sdk',full.value),{sandbox:'danger-full-access'})
  for (const choice of menu.options.slice(1)) {
    const next = nativePermissionMenu('codex_sdk', fields, choice.value, '跟随引擎')
    assert.deepEqual(next.options.filter(option => option.selected).map(option => option.value), [choice.value])
  }
})


test('foreign engine selections inherit without exposing internal serialized values', async () => {
  const { zhCNT } = await import('../src/i18n')
  for (const engine of ['claude', 'claude_agent_sdk', 'pydantic_ai']) {
    const menu = nativePermissionMenu(engine, [{ id: 'permission_mode', name: 'Permissions', type: 'select',
      currentValue: 'auto', options: [{value: 'auto', name: 'auto'}, {value: 'plan', name: 'plan'}] }],
      encodePermissionSelection('codex_sdk', {sandbox:'workspace-write'}), '跟随引擎', null, zhCNT)
    assert.equal(menu.label, '跟随引擎')
    assert.equal(menu.options[0].selected, true)
    if (engine !== 'pydantic_ai') assert.equal(menu.options.length, 2)
  }
})
