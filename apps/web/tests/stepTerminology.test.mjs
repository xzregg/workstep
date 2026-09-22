import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (relativePath) => readFileSync(new URL(relativePath, import.meta.url), 'utf8')

test('workflow node copy consistently uses Step terminology', () => {
  const zhCN = read('../src/i18n/locales/zh-CN.ts')
  const zhTW = read('../src/i18n/locales/zh-TW.ts')
  const jaJP = read('../src/i18n/locales/ja-JP.ts')
  const englishSources = [
    read('../src/i18n/locales/en-US.ts'),
    read('../../landing/src/i18n/en-US.ts'),
  ]

  assert.doesNotMatch(zhCN, /阶段/)
  assert.doesNotMatch(zhTW, /階段|阶段/)
  assert.doesNotMatch(jaJP, /ステージ|阶段/)

  for (const source of englishSources) {
    const values = [...source.matchAll(/:\s*'([^']*)'/g)].map((match) => match[1])
    assert.ok(values.length > 0)
    assert.equal(
      values.filter((value) => /\bstages?\b/i.test(value)).join('\n'),
      '',
    )
  }
})

test('workflow-domain source files and exported symbols use Step names', () => {
  const expectedFiles = [
    'src/components/StepPromptVariablesHint.tsx',
    'src/components/StepConfigFields.tsx',
    'src/components/TaskStepConfigController.tsx',
    'src/components/TaskStepProgressGraph.tsx',
    'src/components/FlowStepApplyPanel.tsx',
    'src/utils/taskStepMention.ts',
    'src/utils/stepConfig.ts',
  ]
  for (const file of expectedFiles) assert.equal(existsSync(file), true, file)

  const client = readFileSync('src/api/client.ts', 'utf8')
  assert.match(client, /interface StatisticsStepRow/)
  assert.match(client, /interface StepExecutionConfig/)
  assert.doesNotMatch(client, /interface (?:StatisticsStageRow|StageExecutionConfig)/)
})
