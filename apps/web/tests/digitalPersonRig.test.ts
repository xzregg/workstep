import test from 'node:test'
import assert from 'node:assert/strict'
import {ROBOT_BONES,createRobotMesh,robotPose,skinPoint} from '../src/components/digital-person/avatar/robotRig'

test('robot mesh has normalized skin weights and independent head, arm and leg bones',()=>{
 const mesh=createRobotMesh(32)
 assert.ok(ROBOT_BONES.length>=10)
 assert.equal(mesh.vertices.length/6,33*33)
 for(let i=0;i<mesh.vertices.length;i+=6){
  assert.ok(mesh.vertices[i+2]>=0&&mesh.vertices[i+2]<ROBOT_BONES.length)
  assert.ok(mesh.vertices[i+4]>=0&&mesh.vertices[i+4]<=1)
  assert.ok(Math.abs(mesh.vertices[i+4]+mesh.vertices[i+5]-1)<1e-6)
 }
 const pose=robotPose('speaking',1,.7)
 const head=skinPoint(.5,.2,2,pose),hand=skinPoint(.23,.62,4,pose),foot=skinPoint(.44,.9,8,pose)
 assert.ok(Math.abs(head[0]-.5)>.001)
 assert.notDeepEqual(head,hand)
 assert.ok(Number.isFinite(foot[0])&&Number.isFinite(foot[1]))
 assert.ok(pose.mouth>.5)
})
test('reduced motion suppresses idle and gesture motion but retains voice mouth state',()=>{
 const one=robotPose('idle',1,0,true),two=robotPose('idle',5,0,true)
 assert.deepEqual(one.matrices,two.matrices)
 assert.ok(robotPose('speaking',2,.8,true).mouth>.5)
 assert.equal(robotPose('thinking',2,.8).mouth,0)
})
test('mouth light follows speaking volume, pulses gently and switches off immediately',()=>{
 const quiet=robotPose('speaking',1,0),loud=robotPose('speaking',1,1)
 assert.ok(quiet.mouthGlow>0)
 assert.ok(loud.mouthGlow>quiet.mouthGlow)
 assert.notEqual(robotPose('speaking',1,.5).mouthGlow,robotPose('speaking',1.3,.5).mouthGlow)
 for(const state of ['idle','listening','thinking','checking'] as const)assert.equal(robotPose(state,1,1).mouthGlow,0)
 assert.equal(robotPose('speaking',1,.5,true).mouthGlow,robotPose('speaking',3,.5,true).mouthGlow)
})
test('eyes blink occasionally with a short double blink and stay still under reduced motion',()=>{
 assert.equal(robotPose('idle',1).blink,0)
 assert.ok(robotPose('idle',2.92).blink>.9)
 assert.ok(robotPose('idle',7.25).blink>.9)
 assert.ok(robotPose('idle',7.63).blink>.9)
 assert.equal(robotPose('idle',2.92,0,true).blink,0)
 assert.notEqual(robotPose('idle',1).eyeGlow,robotPose('idle',2).eyeGlow)
 assert.equal(robotPose('idle',1,0,true).eyeGlow,0)
})
test('relaxed hand vertices follow the arm rather than the leg bones',()=>{
 const mesh=createRobotMesh(100)
 for(const [x,y] of [[.32,.76],[.66,.79]]){
  const offset=(Math.round(y*100)*101+Math.round(x*100))*6
  assert.ok([3,4,5,6].includes(mesh.vertices[offset+2]))
  assert.ok([3,4,5,6].includes(mesh.vertices[offset+3]))
 }
})

test('thinking, tool work and replies have different motion sequences and breathing joints',()=>{
 const think=robotPose('thinking',1,0,false,'calm',0,'think',1)
 const work=robotPose('thinking',1,0,false,'calm',0,'work',1)
 const reply=robotPose('thinking',1,0,false,'calm',0,'reply',1)
 assert.equal(think.motion,'ponder');assert.equal(work.motion,'inspect');assert.equal(reply.motion,'talk')
 assert.notDeepEqual(think.matrices,work.matrices);assert.notDeepEqual(work.matrices,reply.matrices)
 assert.notEqual(robotPose('thinking',1,0,false,'calm',0,'think',5).motion,think.motion)
 assert.notEqual(robotPose('thinking',1).jointGlow,robotPose('thinking',2).jointGlow)
 for(const kind of ['think','work','reply'] as const) for(let time=0;time<20;time+=.25){
  const pose=robotPose('thinking',time,0,false,'calm',0,kind,time)
  assert.ok(pose.jointGlow>=0&&pose.jointGlow<=1)
  assert.ok(pose.matrices.every(Number.isFinite))
 }
})
test('reduced motion freezes event gestures and joint breathing',()=>{
 const one=robotPose('thinking',1,0,true,'calm',0,'work',1),two=robotPose('thinking',5,0,true,'calm',0,'reply',8)
 assert.deepEqual(one.matrices,two.matrices)
 assert.equal(one.jointGlow,two.jointGlow)
 assert.equal(one.motion,'still')
})

test('emotional pose changes expression without replacing playback state and respects reduced motion',()=>{
 const neutral=robotPose('speaking',1,.5,false,'calm',0)
 const happy=robotPose('speaking',1,.5,false,'happy',.8)
 assert.notDeepEqual(happy.matrices,neutral.matrices)
 assert.equal(happy.mouth,neutral.mouth)
 assert.deepEqual(robotPose('idle',1,0,true,'sad',1).matrices,robotPose('idle',1,0,true).matrices)
})

test('thinking raises the hand, actual speech lowers it and only playback lights the mouth',()=>{
 const thinking=robotPose('thinking',1,0,false,'calm',0,'think',1)
 const text=robotPose('thinking',1,0,false,'calm',0,'reply',.5)
 const speaking=robotPose('speaking',1,.7,false,'calm',0,'think',.5)
 assert.ok(thinking.angles[3]>.2,'thinking hand has a visible raised target')
 assert.ok(Math.abs(text.angles[3])<.02&&Math.abs(speaking.angles[3])<.02,'text and audio replies release the raised hand')
 assert.equal(text.mouthGlow,0,'streaming text is not fabricated speech')
 assert.ok(speaking.mouthGlow>0&&speaking.mouth>0)
 assert.equal(speaking.motion,'lower-hand','audio overrides a stale thinking activity cue')
})
