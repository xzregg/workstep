import test from 'node:test'
import assert from 'node:assert/strict'
import {advancePresence,initialPresence,presenceTarget} from '../src/components/digital-person/avatar/presenceMotion'
test('presence transitions blend from the displayed frame and settle independently of refresh rate',()=>{
 const run=(step:number)=>{let value={...initialPresence};for(let elapsed=0;elapsed<1980;elapsed+=step)value=advancePresence(value,'thinking',step);return value}
 const a=run(20),b=run(33)
 assert.ok(Math.abs(a.radius-b.radius)<.002)
 const interrupted=advancePresence(a,'speaking',33)
 assert.ok(interrupted.radius>a.radius&&interrupted.radius<.91)
 assert.ok(interrupted.rotation>a.rotation)
 assert.equal(presenceTarget('checking'),'thinking');assert.equal(presenceTarget('replying'),'working');assert.equal(presenceTarget('unknown'),'idle')
 assert.deepEqual(advancePresence(a,'idle',0),a)
})
