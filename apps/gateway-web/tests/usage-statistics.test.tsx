import assert from 'node:assert/strict'
import { test } from 'node:test'
import { usageCacheRate, usageChange, usageComparisonRanges } from '../src/usageStatistics'

test('cache percentage preserves missing and incompatible measurements', () => {
 assert.equal(usageCacheRate({input_tokens:100,cache_read_tokens:75}),.75)
 assert.equal(usageCacheRate({input_tokens:0,cache_read_tokens:0}),null)
 assert.equal(usageCacheRate({input_tokens:10,cache_read_tokens:20}),null)
 assert.equal(usageCacheRate({input_tokens:100,cache_read_tokens:null}),null)
})
test('comparison handles empty history and missing usage without infinity', () => {
 assert.equal(usageChange(120,100),'+20.0%')
 assert.equal(usageChange(80,100),'−20.0%')
 assert.equal(usageChange(1,0),'新增用量')
 assert.equal(usageChange(0,0),'持平')
 assert.equal(usageChange(null,100),'未上报')
})
test('previous period, leap-year comparison and complete previous calendar month use explicit UTC boundaries', () => {
 const ranges=usageComparisonRanges('2024-02-29T00:00:00Z','2024-03-02T00:00:00Z',new Date('2024-03-12T08:00:00Z'))
 assert.equal(ranges.previous!.from,'2024-02-27T00:00:00.000Z')
 assert.equal(ranges.previous!.to,'2024-02-29T00:00:00.000Z')
 assert.equal(ranges.year!.from,'2023-02-28T00:00:00.000Z')
 assert.equal(ranges.year!.to,'2023-03-02T00:00:00.000Z')
 assert.equal(ranges.month.from,'2024-02-01T00:00:00.000Z')
 assert.equal(ranges.month.to,'2024-03-01T00:00:00.000Z')
 assert.equal(usageComparisonRanges('','').previous,null)
 assert.equal(usageComparisonRanges('2024-02-28T00:00:00Z','2024-02-29T00:00:00Z').year,null)
})
