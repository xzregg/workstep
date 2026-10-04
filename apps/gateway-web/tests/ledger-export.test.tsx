import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ledgerCsv } from '../src/LedgerExportButton'

test('ledger CSV preserves unknown values and escapes cells and spreadsheet formulas', () => {
  const csv = ledgerCsv([{ name: '姓名', key: 'name' }, { name: '成本', key: 'cost' }], [
    { name: '=HYPERLINK("bad")', cost: null }, { name: 'a,b\nnext', cost: 0 },
  ])
  assert.equal(csv, '\ufeff"姓名","成本"\r\n"\'=HYPERLINK(""bad"")",""\r\n"a,b\nnext","0"')
})
