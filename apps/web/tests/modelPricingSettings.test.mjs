import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'

const settingsSource = await readFile(new URL('../src/pages/SettingsPage.tsx', import.meta.url), 'utf8')
const pricingSource = await readFile(new URL('../src/pages/ModelPricingSettings.tsx', import.meta.url), 'utf8')
const apiSource = await readFile(new URL('../src/api/client.ts', import.meta.url), 'utf8')
const statisticsSource = await readFile(new URL('../src/pages/StatisticsPage.tsx', import.meta.url), 'utf8')

test('settings exposes a model pricing section backed by global config APIs', () => {
  assert.match(settingsSource, /activeSection === 'pricing'/)
  assert.match(settingsSource, /<ModelPricingSettings/)
  assert.match(apiSource, /['"]\/system-settings\/model-pricing['"]/) 
  assert.match(pricingSource, /systemSettingsApi\.modelPricing/)
  assert.match(pricingSource, /systemSettingsApi\.saveModelPricing/)
})

test('model pricing lists provider and standalone models with three token prices', () => {
  assert.match(pricingSource, /pricing\.providers/)
  assert.match(pricingSource, /pricing\.standalone_models/)
  assert.match(pricingSource, /input_price/)
  assert.match(pricingSource, /output_price/)
  assert.match(pricingSource, /cache_price/)
  assert.match(pricingSource, /usd_to_cny_rate/)
})

test('model pricing only includes enabled providers', () => {
  assert.doesNotMatch(pricingSource, /providerApi\.list/)
})

test('provider model options come from the saved cache without refresh', () => {
  assert.doesNotMatch(pricingSource, /providerApi\.models/)
  assert.doesNotMatch(pricingSource, /engineApi\.config/)
  assert.doesNotMatch(pricingSource, /engineApi\.list/)
})

test('model pricing supports selecting models and applying three prices in bulk', () => {
  assert.match(pricingSource, /selectedKeys/)
  assert.match(pricingSource, /bulkPrices/)
  assert.match(pricingSource, /applyBulkPrices/)
  assert.match(pricingSource, /pricingSelectAll/)
  assert.match(pricingSource, /pricingBatchApply/)
})

test('model pricing table filters by provider or model and selects visible rows only', () => {
  assert.match(pricingSource, /filterQuery/)
  assert.match(pricingSource, /filteredRows/)
  assert.match(pricingSource, /row\.group\.toLocaleLowerCase/)
  assert.match(pricingSource, /row\.model\.toLocaleLowerCase/)
  assert.match(pricingSource, /pricingFilterPlaceholder/)
  assert.match(pricingSource, /new Set\(filteredRows\.map/)
})

test('statistics displays the calculated total and per-model cost', () => {
  assert.match(apiSource, /currency: 'USD' \| 'CNY'/)
  assert.match(apiSource, /cost: number/)
  assert.match(statisticsSource, /statistics\.totalCost/)
  assert.match(statisticsSource, /row\.cost/)
})
