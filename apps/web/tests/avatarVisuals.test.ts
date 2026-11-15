import test from 'node:test'
import assert from 'node:assert/strict'
import {avatarPose,advanceVoice} from '../src/components/digital-person/avatar/visualState'

test('actual playback lowers the thinking hand; work and thinking use the intact chin pose',()=>{
 assert.equal(avatarPose('thinking',false),'thinking')
 assert.equal(avatarPose('working',false),'thinking')
 assert.equal(avatarPose('thinking',true),'neutral')
 assert.equal(avatarPose('replying',false),'neutral')
})
test('voice release converges smoothly without stale amplitude and is independent of frame rate',()=>{
 const a=advanceVoice({level:0,activity:0},true,.8,300)
 assert.ok(a.level>.7&&a.activity>.6)
 let fine={level:0,activity:0}
 for(let i=0;i<30;i++)fine=advanceVoice(fine,true,.8,10)
 assert.ok(Math.abs(a.level-fine.level)<1e-9)
 let release=a
 for(let i=0;i<300;i++)release=advanceVoice(release,false,1,20)
 assert.ok(release.level<.001&&release.activity<.002)
 assert.equal(advanceVoice({level:0,activity:0},true,NaN,20).level,0)
})
