import test from 'node:test'
import assert from 'node:assert/strict'
import {previewFrameDelay} from '../src/components/face-recognition/useFaceRecognition'

test('slow mobile recognition leaves idle time instead of immediately launching another inference',()=>{
 assert.equal(previewFrameDelay(10,120,true),240,'120ms detection must not become back-to-back work')
 assert.equal(previewFrameDelay(10,5,true),100)
 assert.equal(previewFrameDelay(5,5,true),195,'slower configured presets retain their cadence')
 assert.equal(previewFrameDelay(10,120,false),0,'desktop scheduling is unchanged')
})
