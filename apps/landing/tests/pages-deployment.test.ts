import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('uses the Pages site path for both custom domains and repository URLs', () => {
  const workflow = readFileSync(new URL('../../../.github/workflows/pages.yml', import.meta.url), 'utf8')
  expect(workflow).toMatch(/id: pages\s+with: \{ enablement: true \}/)
  expect(workflow).toContain('LANDING_BASE: ${{ steps.pages.outputs.base_path }}/')
})
