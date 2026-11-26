import test from 'node:test'
import assert from 'node:assert/strict'
import { completePhoneTurn, withoutPlaybackEcho } from '../src/audio/phoneTurn'

test('phone endpoints keep unfinished thoughts and preserve useful short commands',()=>{
 for(const text of ['我','我想','我想 嗯','帮我','我想查一下','然后呢','因为今天下雨所以','Please help me','嗯','啊','呃']) assert.equal(completePhoneTurn(text),false,text)
 for(const text of ['停','等一下','停止','继续','取消','重试','下一步','打开灯','查天气','我想查一下明天北京的天气','今天天气很好','Stop','Turn it off']) assert.equal(completePhoneTurn(text),true,text)
})

test('playback text, including partial or repeated echo, cannot interrupt',()=>{
 const reference='今天北京天气晴朗，温度二十五度，适合出门。'
 for(const text of ['今天北京天气晴朗','北京天气晴朗温度二十五度','嗯','啊']) assert.equal(withoutPlaybackEcho(text,reference),'',text)
 assert.equal(withoutPlaybackEcho('停止',reference),'停止')
 assert.equal(withoutPlaybackEcho('停',reference),'停')
 assert.equal(withoutPlaybackEcho('帮我查看北京天气晴朗的原因',reference),'帮我查看北京天气晴朗的原因')
 assert.equal(withoutPlaybackEcho('今天北京天气晴朗，帮我查明天的天气',reference),'帮我查明天的天气')
 assert.equal(withoutPlaybackEcho('𝒜𝒜𝒜𝒜，停止','𝒜𝒜𝒜𝒜'),'停止','Unicode echo boundaries keep the following command')
 assert.equal(withoutPlaybackEcho('停止',''),'','unknown playback reference fails closed')
})
