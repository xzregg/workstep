import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ComponentContext,
  GenericBinder,
  MessageProcessor,
  type A2uiClientAction,
} from '@a2ui/web_core/v0_9'
import { basicCatalog } from '@a2ui/react/v0_9'

import {
  bindStaticInteractiveValues,
  ensureA2uiRoots,
  extractA2uiMessages,
  hasA2uiBlocks,
  isHiddenA2uiActionMessage,
  normalizeA2uiMessages,
  normalizeA2uiInteractiveComponents,
  reconcileA2uiReferences,
  a2uiActionMessageParams,
  resolveA2uiFlowSteps,
  pendingAutoApplyProposal,
  splitA2uiUpdateComponents,
  stripA2uiBlocks,
  stripA2uiBlocksForDisplay,
  stripAssistantPayloadsForDisplay,
  type A2uiReferenceStore,
} from '../src/utils/a2ui.ts'

const createSurfaceLine = JSON.stringify({
  version: 'v0.9.1',
  type: 'createSurface',
  createSurface: {
    surfaceId: 'main',
    title: 'A2UI 演示',
    catalogId: '',
    components: [],
  },
})

test('extracts single-line JSONL messages from a complete fence', () => {
  const content = [
    '先说明',
    '',
    '```a2ui',
    createSurfaceLine,
    '{"version":"v0.9.1","type":"updateComponents","updateComponents":{"surfaceId":"main","components":[{"component":"Text","id":"t1","text":"## 说明"}]}}',
    '```',
    '',
    '结尾正文',
  ].join('\n')

  const messages = extractA2uiMessages(content)
  assert.equal(messages.length, 2)
  assert.ok('createSurface' in messages[0])
  assert.ok('updateComponents' in messages[1])
  if ('createSurface' in messages[0]) {
    assert.equal(messages[0].createSurface.surfaceId, 'main')
  }
  if ('updateComponents' in messages[1]) {
    assert.deepEqual(messages[1].updateComponents.components, [
      { component: 'Text', id: 't1', text: '## 说明' },
    ])
  }
})

test('accumulates pretty-printed multi-line JSON without losing messages', () => {
  const payload = {
    version: 'v0.9.1',
    type: 'updateComponents',
    updateComponents: {
      surfaceId: 'main',
      components: [
        { component: 'Text', id: 't1', text: '## 说明' },
        { component: 'Image', id: 'img1', url: '项目A/.workstep/uploads/abc-123.png' },
      ],
    },
  }
  const content = '```a2ui\n' + JSON.stringify(payload, null, 2) + '\n```'

  const messages = extractA2uiMessages(content)
  assert.equal(messages.length, 1)
  assert.ok('updateComponents' in messages[0])
  if ('updateComponents' in messages[0]) {
    assert.equal(messages[0].updateComponents.components.length, 2)
    assert.equal(
      (messages[0].updateComponents.components[1] as { url?: string }).url,
      '项目A/.workstep/uploads/abc-123.png',
    )
  }
})

test('skips stray non-JSON text inside a fence', () => {
  const content = [
    '```a2ui',
    '这是一段模型输出的杂散文字',
    createSurfaceLine,
    '```',
  ].join('\n')

  const messages = extractA2uiMessages(content)
  assert.equal(messages.length, 1)
})

test('ignores unclosed streaming fences', () => {
  const content = '```a2ui\n' + createSurfaceLine
  assert.equal(extractA2uiMessages(content).length, 0)
  assert.equal(hasA2uiBlocks(content), false)
  assert.equal(stripA2uiBlocks(content), content)
  assert.equal(stripA2uiBlocksForDisplay(content), '')
})

test('hides an incomplete streaming A2UI payload but keeps preceding prose', () => {
  const content = '请填写下面的问卷。\n\n```a2ui\n{"version":"v0.9.1"'
  assert.equal(stripA2uiBlocksForDisplay(content), '请填写下面的问卷。\n\n')
})

test('hides workflow canvas JSON payloads from assistant message display', () => {
  const content = '方案已调整完成。\n\n当前完整画布 JSON 如下：\n\n```json\n'
    + '{"nodes":[{"id":1,"type":"req","title":"需求"}],"connections":[]}\n'
    + '```\n'
  assert.equal(stripAssistantPayloadsForDisplay(content), '方案已调整完成。\n\n')
})

test('keeps ordinary JSON examples visible in assistant messages', () => {
  const content = '示例：\n```json\n{"enabled":true}\n```\n'
  assert.equal(stripAssistantPayloadsForDisplay(content), content)
})

test('detects complete fences and leaves plain text alone', () => {
  assert.equal(hasA2uiBlocks('```a2ui\n{}\n```'), true)
  assert.equal(hasA2uiBlocks('```a2ui\n' + createSurfaceLine), false)
  assert.equal(hasA2uiBlocks('正文没有围栏'), false)
})

test('strips complete fences and keeps surrounding text', () => {
  const content = 'A\n```a2ui\n{}\n```\nB'
  assert.equal(stripA2uiBlocks(content), 'A\nB')

  const withBody = [
    '开头说明',
    '',
    '```a2ui',
    createSurfaceLine,
    '```',
    '',
    '结尾正文',
  ].join('\n')
  const stripped = stripA2uiBlocks(withBody)
  assert.ok(!stripped.includes('```a2ui'))
  assert.ok(stripped.includes('开头说明'))
  assert.ok(stripped.includes('结尾正文'))
})

test('normalizes project-relative upload paths for Image components', () => {
  const messages = [
    {
      version: 'v0.9.1',
      type: 'updateComponents',
      updateComponents: {
        surfaceId: 'main',
        components: [
          { component: 'Image', id: 'img1', url: '项目A/.workstep/uploads/abc-123.png' },
          { component: 'Text', id: 't1', text: '说明' },
          { component: 'Image', id: 'img2', url: 'https://example.com/pic.png' },
        ],
      },
    },
  ]

  const normalized = normalizeA2uiMessages(messages, '项目A')
  assert.ok('updateComponents' in normalized[0])
  if ('updateComponents' in normalized[0]) {
    const components = normalized[0].updateComponents.components as Array<
      { component: string; url?: string }
    >
    assert.equal(
      components[0].url,
      '/api/fs/serve/abc-123.png?project_id=%E9%A1%B9%E7%9B%AEA',
    )
    assert.equal(components[1].url, undefined)
    assert.equal(components[2].url, 'https://example.com/pic.png')
  }
})

test('normalizes workspace-relative upload paths without a project-name prefix', () => {
  const messages = normalizeA2uiMessages([
    {
      version: 'v0.9.1',
      type: 'updateComponents',
      updateComponents: {
        surfaceId: 'main',
        components: [
          { component: 'Image', id: 'img1', url: '.workstep/uploads/abc-123.png' },
        ],
      },
    },
  ], 'project-id')

  assert.ok('updateComponents' in messages[0])
  if ('updateComponents' in messages[0]) {
    assert.equal(
      (messages[0].updateComponents.components[0] as { url?: string }).url,
      '/api/fs/serve/abc-123.png?project_id=project-id',
    )
  }
})

test('leaves messages untouched when no project id is provided', () => {
  const messages = [
    {
      version: 'v0.9.1',
      type: 'updateComponents',
      updateComponents: {
        surfaceId: 'main',
        components: [
          { component: 'Image', id: 'img1', url: '项目A/.workstep/uploads/abc-123.png' },
        ],
      },
    },
  ]
  assert.equal(normalizeA2uiMessages(messages, undefined), messages)
})

test('repairs common model aliases for interactive A2UI controls', () => {
  const messages = [{
    version: 'v0.9.1',
    updateComponents: {
      surfaceId: 'brief',
      components: [
        {
          component: 'ChoicePicker', id: 'pageType', value: [],
          mutuallyExclusive: true,
          options: [{ label: '表单页', value: 'form' }],
        },
        {
          component: 'ChoicePicker', id: 'styles', value: [],
          multipleSelection: true,
          options: [{ label: '科技感', value: 'tech' }],
        },
        {
          component: 'TextField', id: 'name', placeholder: '请输入参考名称', value: '',
        },
        {
          component: 'TextField', id: 'extra', placeholder: '请输入补充要求',
          multiline: true, value: '',
        },
        {
          component: 'Button', id: 'submit', label: '提交',
          action: { event: { name: 'submit_clarification', context: {} } },
        },
      ],
    },
  }]

  const normalized = normalizeA2uiInteractiveComponents(messages)
  assert.ok('updateComponents' in normalized[0])
  if (!('updateComponents' in normalized[0])) return
  const components = normalized[0].updateComponents.components as Array<Record<string, unknown>>
  assert.equal(components.find((item) => item.id === 'pageType')?.variant, 'mutuallyExclusive')
  assert.equal(components.find((item) => item.id === 'styles')?.variant, 'multipleSelection')
  assert.equal(components.find((item) => item.id === 'name')?.label, '请输入参考名称')
  assert.equal(components.find((item) => item.id === 'extra')?.variant, 'longText')
  assert.equal(components.find((item) => item.id === 'submit')?.child, 'submit-label')
  assert.deepEqual(components.find((item) => item.id === 'submit-label'), {
    component: 'Text', id: 'submit-label', text: '提交',
  })
})

test('injects an implicit Column root wrapping top-level components', () => {
  const messages = [
    {
      version: 'v0.9.1',
      type: 'createSurface',
      createSurface: { surfaceId: 'main', catalogId: '' },
    },
    {
      version: 'v0.9.1',
      type: 'updateComponents',
      updateComponents: {
        surfaceId: 'main',
        components: [
          { component: 'Row', id: 'r1', children: ['t1'] },
          { component: 'Text', id: 't1', text: '说明' },
          { component: 'Text', id: 't2', text: '独立文本' },
        ],
      },
    },
  ]

  const normalized = ensureA2uiRoots(messages)
  const update = normalized.find((m) => 'updateComponents' in m)
  assert.ok(update && 'updateComponents' in update)
  assert.deepEqual(update.updateComponents.components[0], {
    component: 'Column',
    id: 'root',
    children: ['r1', 't2'],
  })
  // t1 是 r1 的 children，不重复出现在 root children 里。
  assert.deepEqual(
    update.updateComponents.components[0].children,
    ['r1', 't2'],
  )
})

test('keeps an explicit root component untouched', () => {
  const messages = [
    {
      version: 'v0.9.1',
      type: 'updateComponents',
      updateComponents: {
        surfaceId: 'main',
        components: [
          { component: 'Column', id: 'root', children: ['t1'] },
          { component: 'Text', id: 't1', text: '说明' },
        ],
      },
    },
  ]
  assert.equal(ensureA2uiRoots(messages), messages)
})

test('leaves surfaces without components unchanged', () => {
  const messages = [
    {
      version: 'v0.9.1',
      type: 'createSurface',
      createSurface: { surfaceId: 'main', catalogId: '' },
    },
  ]
  assert.equal(ensureA2uiRoots(messages), messages)
})

test('injects roots per surface independently', () => {
  const messages = [
    {
      version: 'v0.9.1',
      type: 'updateComponents',
      updateComponents: {
        surfaceId: 'a',
        components: [{ component: 'Text', id: 'a1', text: 'A' }],
      },
    },
    {
      version: 'v0.9.1',
      type: 'updateComponents',
      updateComponents: {
        surfaceId: 'b',
        components: [{ component: 'Text', id: 'b1', text: 'B' }],
      },
    },
  ]
  const normalized = ensureA2uiRoots(messages)
  const updates = normalized.filter((m): m is typeof messages[number] =>
    'updateComponents' in m,
  )
  for (const update of updates) {
    assert.ok('updateComponents' in update)
    const first = update.updateComponents.components[0] as { id?: string }
    assert.equal(first.id, 'root')
  }
})

function referenceStore(components: Record<string, unknown>): A2uiReferenceStore & {
  map: Map<string, unknown>
} {
  const map = new Map(Object.entries(components))
  return {
    map,
    componentIds: () => Array.from(map.keys()),
    getProperties: (id) => map.get(id) as Record<string, unknown> | undefined,
    setProperties: (id, props) => {
      map.set(id, props)
    },
    addText: (id, text) => {
      map.set(id, { text })
    },
  }
}

test('synthesizes Text components for dangling child references', () => {
  const store = referenceStore({
    root: { children: ['hint', 'b1', 'b2'] },
    hint: { text: '请选择' },
    b1: { child: '简洁版', variant: 'primary' },
    b2: { child: '标准版' },
  })
  reconcileA2uiReferences(store)
  assert.deepEqual(store.map.get('简洁版'), { text: '简洁版' })
  assert.deepEqual(store.map.get('标准版'), { text: '标准版' })
  // 已有引用不受影响，原组件属性保持不变。
  assert.deepEqual(store.map.get('hint'), { text: '请选择' })
  assert.deepEqual(store.map.get('b1'), { child: '简洁版', variant: 'primary' })
  assert.deepEqual(store.map.get('root'), { children: ['hint', 'b1', 'b2'] })
})

test('synthesizes Texts for dangling children and tab refs', () => {
  const store = referenceStore({
    root: { children: ['a', 'missing-1'] },
    tabs: { tabs: [{ title: 'T', child: 'missing-2' }] },
  })
  reconcileA2uiReferences(store)
  assert.deepEqual(store.map.get('missing-1'), { text: 'missing-1' })
  assert.deepEqual(store.map.get('missing-2'), { text: 'missing-2' })
  assert.deepEqual(store.map.get('root'), { children: ['a', 'missing-1'] })
  assert.deepEqual(store.map.get('tabs'), {
    tabs: [{ title: 'T', child: 'missing-2' }],
  })
})

test('leaves fully resolved surfaces untouched', () => {
  const store = referenceStore({
    root: { children: ['t1'] },
    t1: { text: '说明' },
    btn: { child: 't2' },
    t2: { text: '按钮' },
  })
  reconcileA2uiReferences(store)
  assert.equal(store.map.size, 4)
  assert.deepEqual(store.map.get('t1'), { text: '说明' })
  assert.deepEqual(store.map.get('btn'), { child: 't2' })
})

test('splits updateComponents into one message per component', () => {
  const messages = [
    {
      version: 'v0.9.1',
      type: 'createSurface',
      createSurface: { surfaceId: 'main', catalogId: '' },
    },
    {
      version: 'v0.9.1',
      type: 'updateComponents',
      updateComponents: {
        surfaceId: 'main',
        components: [
          { component: 'Text', id: 't1', text: '一' },
          { component: 'Button', id: 'b1', child: 't1' },
        ],
      },
    },
  ]
  const split = splitA2uiUpdateComponents(messages)
  assert.equal(split.length, 3)
  assert.ok('createSurface' in split[0])
  if ('updateComponents' in split[1]) {
    assert.deepEqual(split[1].updateComponents.components, [
      { component: 'Text', id: 't1', text: '一' },
    ])
  }
  if ('updateComponents' in split[2]) {
    assert.deepEqual(split[2].updateComponents.components, [
      { component: 'Button', id: 'b1', child: 't1' },
    ])
  }
})

test('leaves messages without updateComponents untouched by splitting', () => {
  const messages = [
    {
      version: 'v0.9.1',
      type: 'createSurface',
      createSurface: { surfaceId: 'main', catalogId: '' },
    },
  ]
  assert.deepEqual(splitA2uiUpdateComponents(messages), messages)
})

test('bindStaticInteractiveValues rebinds static DYNAMIC props to the data model', () => {
  const processor = new MessageProcessor([basicCatalog])
  processor.processMessages([
    {
      version: 'v0.9.1',
      createSurface: { surfaceId: 's1', catalogId: basicCatalog.id },
    },
    {
      version: 'v0.9.1',
      updateComponents: {
        surfaceId: 's1',
        components: [
          { component: 'Column', id: 'root', children: ['f', 'p', 't', 'b', 'bl'] },
          { component: 'TextField', id: 'f', label: '机体', value: '初代' },
          {
            component: 'ChoicePicker', id: 'p', value: ['unbox'],
            options: [{ label: '开箱', value: 'unbox' }],
          },
          { component: 'Text', id: 't', text: 'hello' },
          { component: 'Button', id: 'b', child: 'bl' },
          { component: 'Text', id: 'bl', text: '按钮' },
        ],
      },
    },
  ])
  const surface = Array.from(processor.model.surfacesMap.values())[0]
  bindStaticInteractiveValues(surface)

  const textField = surface.componentsModel.get('f')!
  assert.deepEqual(textField.properties.value, { path: '/a2ui/s1/f/value' })
  assert.equal(surface.dataModel.get('/a2ui/s1/f/value'), '初代')

  const picker = surface.componentsModel.get('p')!
  assert.deepEqual(picker.properties.value, { path: '/a2ui/s1/p/value' })
  assert.deepEqual(surface.dataModel.get('/a2ui/s1/p/value'), ['unbox'])

  // DYNAMIC text props are bound too (display value stays identical).
  const text = surface.componentsModel.get('t')!
  assert.deepEqual(text.properties.text, { path: '/a2ui/s1/t/text' })
  assert.equal(surface.dataModel.get('/a2ui/s1/t/text'), 'hello')

  // Static/structural props (Button.child) are left untouched.
  const button = surface.componentsModel.get('b')!
  assert.equal(button.properties.child, 'bl')
})

test('bindStaticInteractiveValues keeps existing { path } bindings untouched', () => {
  const processor = new MessageProcessor([basicCatalog])
  processor.processMessages([
    {
      version: 'v0.9.1',
      createSurface: { surfaceId: 's1', catalogId: basicCatalog.id },
    },
    {
      version: 'v0.9.1',
      updateComponents: {
        surfaceId: 's1',
        components: [
          { component: 'Column', id: 'root', children: ['f'] },
          { component: 'TextField', id: 'f', label: '机体', value: { path: '/state/name' } },
        ],
      },
    },
  ])
  const surface = Array.from(processor.model.surfacesMap.values())[0]
  bindStaticInteractiveValues(surface)
  const textField = surface.componentsModel.get('f')!
  assert.deepEqual(textField.properties.value, { path: '/state/name' })
  assert.equal(surface.dataModel.get('/a2ui/s1/f/value'), undefined)
})

test('interactive form values update and resolve into the submit action', async () => {
  const actions: A2uiClientAction[] = []
  const processor = new MessageProcessor([basicCatalog], (action) => {
    actions.push(action)
  })
  processor.processMessages([
    {
      version: 'v0.9.1',
      createSurface: { surfaceId: 'brief', catalogId: basicCatalog.id },
    },
    {
      version: 'v0.9.1',
      updateComponents: {
        surfaceId: 'brief',
        components: [
          { component: 'Column', id: 'root', children: ['kind', 'reference', 'submit-label', 'submit'] },
          {
            component: 'ChoicePicker', id: 'kind', label: '页面类型', value: [],
            variant: 'mutuallyExclusive', displayStyle: 'chips',
            options: [
              { label: '机体展示页', value: 'showcase' },
              { label: '产品落地页', value: 'landing' },
            ],
          },
          { component: 'TextField', id: 'reference', label: '参考机体', value: '' },
          { component: 'Text', id: 'submit-label', text: '提交' },
          {
            component: 'Button', id: 'submit', child: 'submit-label',
            action: {
              event: {
                name: 'submit_brief',
                context: {
                  kind: { path: '/a2ui/brief/kind/value' },
                  reference: { path: '/a2ui/brief/reference/value' },
                },
              },
            },
          },
        ],
      },
    },
  ])
  const surface = Array.from(processor.model.surfacesMap.values())[0]
  bindStaticInteractiveValues(surface)

  const pickerApi = surface.catalog.components.get('ChoicePicker')!
  const picker = new GenericBinder<any>(
    new ComponentContext(surface, 'kind'),
    pickerApi.schema,
  )
  picker.snapshot.setValue(['showcase'])

  const fieldApi = surface.catalog.components.get('TextField')!
  const field = new GenericBinder<any>(
    new ComponentContext(surface, 'reference'),
    fieldApi.schema,
  )
  field.snapshot.setValue('RX-78-2')

  const buttonApi = surface.catalog.components.get('Button')!
  const button = new GenericBinder<any>(
    new ComponentContext(surface, 'submit'),
    buttonApi.schema,
  )
  button.snapshot.action()
  await new Promise((resolve) => setTimeout(resolve, 0))

  assert.equal(actions.length, 1)
  assert.deepEqual(actions[0].context, {
    kind: ['showcase'],
    reference: 'RX-78-2',
  })
})

test('formats submit actions as a natural form summary', () => {
  assert.deepEqual(a2uiActionMessageParams({
    name: 'submit_brief',
    surfaceId: 'brief',
    sourceComponentId: 'submit',
    timestamp: '2026-08-10T00:00:00.000Z',
    context: { kind: ['showcase'], reference: 'RX-78-2' },
  }), {
    name: '已提交表单',
    context: '：kind：showcase；reference：RX-78-2',
  })
})

test('formats discovery form submissions as a natural Chinese summary', () => {
  assert.deepEqual(a2uiActionMessageParams({
    name: '[form answers — discovery]',
    surfaceId: 'discovery',
    sourceComponentId: 'submit',
    timestamp: '2026-08-10T00:00:00.000Z',
    context: {
      '这个高达页面是什么？': '机体展示页（单台高达英雄式呈现）',
      '具体是哪台机体或哪个系列？': '(skipped)',
      '视觉调性': ['科技 / 军事档案感', '编辑 / 杂志感'],
      '大概需要多少内容？': '(skipped)',
    },
  }), {
    name: '已提交表单',
    context: '：这个高达页面是什么？：机体展示页（单台高达英雄式呈现）；视觉调性：科技 / 军事档案感、编辑 / 杂志感',
  })
})

test('formats legacy apply-flow actions without embedded steps naturally', () => {
  assert.deepEqual(a2uiActionMessageParams({
    name: 'apply_flow',
    surfaceId: 'flow-choice',
    sourceComponentId: 'p1',
    timestamp: '2026-08-10T00:00:00.000Z',
    context: { proposal: 1 },
  }), {
    name: '选择流程方案',
    context: '：第 1 个方案',
  })
})

test('recognizes legacy internal apply-flow messages for hidden rendering', () => {
  assert.equal(isHiddenA2uiActionMessage('apply_flow：{"proposal":1}'), true)
  assert.equal(isHiddenA2uiActionMessage('apply_flow: {"proposal": 2}'), true)
  assert.equal(isHiddenA2uiActionMessage('请应用第 1 个方案'), false)
})

test('parses form answers embedded in the A2UI action name', () => {
  assert.deepEqual(a2uiActionMessageParams({
    name: '[form answers — discovery]\n- 页面类型: 机体展示页\n- 具体机体: (skipped)\n- 视觉调性: 科技感, 编辑感',
    surfaceId: 'discovery',
    sourceComponentId: 'submit',
    timestamp: '2026-08-10T00:00:00.000Z',
    context: {},
  }), {
    name: '已提交表单',
    context: '：页面类型：机体展示页；视觉调性：科技感, 编辑感',
  })
})

test('historical flow actions prefer their self-contained steps payload', () => {
  const historical = { nodes: [{ id: 1, type: 'req', title: '历史方案' }], connections: [] }
  const latest = { nodes: [{ id: 1, type: 'req', title: '最新方案' }], connections: [] }
  const resolved = resolveA2uiFlowSteps({
    name: 'apply_flow',
    surfaceId: 'flow-choice',
    sourceComponentId: 'p1',
    timestamp: '2026-08-10T00:00:00.000Z',
    context: { proposal: 1, stepsJson: JSON.stringify(historical) },
  }, [{ id: 'latest-1', steps: latest }])

  assert.deepEqual(resolved, { steps: historical, proposalId: '' })
})

test('returns only an unapplied auto-apply proposal', () => {
  const proposals = [
    { id: 'p1', steps: {}, autoApply: false },
    { id: 'p2', steps: { nodes: [] }, autoApply: true },
  ]
  assert.equal(pendingAutoApplyProposal(proposals, null)?.id, 'p2')
  assert.equal(pendingAutoApplyProposal(proposals, 'p2'), undefined)
})
