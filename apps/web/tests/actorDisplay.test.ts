import assert from 'node:assert/strict'
import test from 'node:test'

import {
  displayUserDetail,
  displayUserSender,
  isSameActorName,
} from '../src/utils/actorDisplay'

test('same actor names are normalized before comparison', () => {
  assert.equal(isSameActorName(' 演示用户 ', '演示用户'), true)
  assert.equal(isSameActorName('演示用户', '其他用户'), false)
  assert.equal(isSameActorName('', '演示用户'), false)
})

test('the current user is displayed as me', () => {
  assert.equal(displayUserSender('演示用户', '演示用户', '我', '历史用户'), '我')
  assert.equal(displayUserSender('其他用户', '演示用户', '我', '历史用户'), '其他用户')
  assert.equal(displayUserSender('', '演示用户', '我', '历史用户'), '历史用户')
  assert.equal(displayUserSender('演示用户', '', '我', '历史用户'), '演示用户')
})

test('hover detail keeps the original author name instead of the me label', () => {
  assert.equal(
    displayUserDetail('演示用户', 'MacBook Pro', '我'),
    '演示用户 · MacBook Pro',
  )
  assert.equal(
    displayUserDetail('其他用户', 'Windows PC', '我'),
    '其他用户 · Windows PC',
  )
  assert.equal(displayUserDetail('', 'MacBook Pro', '我'), '我 · MacBook Pro')
  assert.equal(displayUserDetail('演示用户', '', '我'), '演示用户')
  assert.equal(
    displayUserDetail('张三', 'MacBook Pro', '历史用户', 'zhangsan'),
    '张三 (@zhangsan) · MacBook Pro',
  )
})


test('channel avatar details do not repeat the saved platform or sender account', () => {
  assert.equal(
    displayUserDetail('企业微信 · DemoMember', '企业微信', '历史用户', 'DemoMember'),
    'DemoMember · 企业微信',
  )
  assert.equal(
    displayUserDetail('钉钉 · 张三', '钉钉', '历史用户', 'zhangsan'),
    '张三 (@zhangsan) · 钉钉',
  )
  assert.equal(
    displayUserDetail('企业微信 · DemoMember', '企业微信测试设备', '历史用户', 'DemoAlias'),
    'DemoMember (@DemoAlias) · 企业微信测试设备',
  )
})

test('channel author names omit the legacy platform prefix', () => {
  assert.equal(displayUserSender('企业微信 · DemoMember', '', '我', '历史用户'), 'DemoMember')
  assert.equal(displayUserSender('钉钉 · 小王', '', '我', '历史用户'), '小王')
  assert.equal(displayUserDetail('DemoMember', '企业微信', '历史用户', 'DemoMember'), 'DemoMember · 企业微信')
})
