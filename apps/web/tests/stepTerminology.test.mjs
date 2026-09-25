import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

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

  const task = readFileSync('src/api/task.ts', 'utf8')
  const statistics = readFileSync('src/api/statistics.ts', 'utf8')
  assert.match(statistics, /interface StatisticsStepRow/)
  assert.match(task, /interface StepExecutionConfig/)
  assert.doesNotMatch(statistics, /interface StatisticsStageRow/)
  assert.doesNotMatch(task, /interface StageExecutionConfig/)
})
