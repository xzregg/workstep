import test from 'node:test'
import assert from 'node:assert/strict'
import {selectRobotActivity} from '../src/components/digital-person/avatar/robotActivity'
import type {AssistantChatMessage} from '../src/stores/assistantStore'
const reply=(events:AssistantChatMessage['events'],content=''):AssistantChatMessage=>({id:'reply-1',role:'assistant',status:'running',content,events})
test('avatar maps real reasoning, tool and text events to distinct gestures without retriggering every token',()=>{
 const thinking=selectRobotActivity([reply([{type:'REASONING_MESSAGE_CHUNK',delta:'思考'}])],true)
 assert.equal(thinking?.kind,'think')
 const first=selectRobotActivity([reply([{type:'TOOL_CALL_START',toolCallId:'tool-1'}])],true)
 assert.equal(first?.kind,'work')
 assert.equal(selectRobotActivity([reply([{type:'TOOL_CALL_START',toolCallId:'tool-1'},{type:'TOOL_CALL_ARGS',toolCallId:'tool-1',delta:'{}'}])],true)?.key,first?.key)
 assert.notEqual(selectRobotActivity([reply([{type:'TOOL_CALL_START',toolCallId:'tool-2'}])],true)?.key,first?.key)
 const one=selectRobotActivity([reply([{type:'TEXT_MESSAGE_CONTENT',delta:'你好',seq:1}])],true)
 assert.equal(one?.kind,'reply')
 assert.equal(selectRobotActivity([reply([{type:'TEXT_MESSAGE_CONTENT',delta:'继续',seq:20}])],true)?.key,one?.key)
 assert.equal(selectRobotActivity([reply([],'正在回复')],true)?.kind,'reply')
})
test('finished history and user messages do not replay old avatar events',()=>{
 assert.equal(selectRobotActivity([reply([{type:'TOOL_CALL_START',toolCallId:'old'}])],false),null)
 assert.equal(selectRobotActivity([{...reply([{type:'TOOL_CALL_START'}]),status:'succeeded'}],true),null)
 assert.equal(selectRobotActivity([{id:'user',role:'user',content:'看看',status:'succeeded'}],true)?.kind,'think')
})

test('parallel tool results and argument-end events keep work gestures active',()=>{
 const events=[{type:'TOOL_CALL_START',toolCallId:'one'},{type:'TOOL_CALL_START',toolCallId:'two'},{type:'TOOL_CALL_END',toolCallId:'one'},{type:'TOOL_CALL_RESULT',toolCallId:'two'}]
 assert.equal(selectRobotActivity([reply(events)],true)?.kind,'work')
 assert.equal(selectRobotActivity([reply([...events,{type:'TOOL_CALL_RESULT',toolCallId:'one'}])],true)?.kind,'think')
 assert.equal(selectRobotActivity([reply([{type:'RUN_ERROR'}])],true),null)
})
