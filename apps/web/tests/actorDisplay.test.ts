import assert from 'node:assert/strict'
import test from 'node:test'

import {
  displayUserDetail,
  displayUserSender,
  isSameActorName,
} from '../src/utils/actorDisplay'

test('same actor names are normalized before comparison', () => {
  assert.equal(isSameActorName(' 张三丰 ', '张三丰'), true)
  assert.equal(isSameActorName('张三丰', '其他用户'), false)
  assert.equal(isSameActorName('', '张三丰'), false)
})

test('the current user is displayed as me', () => {
  assert.equal(displayUserSender('张三丰', '张三丰', '我', '历史用户'), '我')
  assert.equal(displayUserSender('其他用户', '张三丰', '我', '历史用户'), '其他用户')
  assert.equal(displayUserSender('', '张三丰', '我', '历史用户'), '历史用户')
  assert.equal(displayUserSender('张三丰', '', '我', '历史用户'), '张三丰')
})

test('hover detail keeps the original author name instead of the me label', () => {
  assert.equal(
    displayUserDetail('张三丰', 'MacBook Pro', '我'),
    '张三丰 · MacBook Pro',
  )
  assert.equal(
    displayUserDetail('其他用户', 'Windows PC', '我'),
    '其他用户 · Windows PC',
  )
  assert.equal(displayUserDetail('', 'MacBook Pro', '我'), '我 · MacBook Pro')
  assert.equal(displayUserDetail('张三丰', '', '我'), '张三丰')
  assert.equal(
    displayUserDetail('张三', 'MacBook Pro', '历史用户', 'zhangsan'),
    '张三 (@zhangsan) · MacBook Pro',
  )
})


test('channel avatar details do not repeat the saved platform or sender account', () => {
  assert.equal(
    displayUserDetail('企业微信 · ZhangSanFeng', '企业微信', '历史用户', 'ZhangSanFeng'),
    'ZhangSanFeng · 企业微信',
  )
  assert.equal(
    displayUserDetail('钉钉 · 张三', '钉钉', '历史用户', 'zhangsan'),
    '张三 (@zhangsan) · 钉钉',
  )
  assert.equal(
    displayUserDetail('企业微信 · ZhangSanFeng', '企业微信测试设备', '历史用户', 'XieZhao'),
    'ZhangSanFeng (@XieZhao) · 企业微信测试设备',
  )
})

test('channel author names omit the legacy platform prefix', () => {
  assert.equal(displayUserSender('企业微信 · ZhangSanFeng', '', '我', '历史用户'), 'ZhangSanFeng')
  assert.equal(displayUserSender('钉钉 · 小王', '', '我', '历史用户'), '小王')
  assert.equal(displayUserDetail('ZhangSanFeng', '企业微信', '历史用户', 'ZhangSanFeng'), 'ZhangSanFeng · 企业微信')
})
