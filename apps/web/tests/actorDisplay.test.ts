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
  assert.equal(displayUserSender('张三丰', '张三丰', '我'), '我')
  assert.equal(displayUserSender('其他用户', '张三丰', '我'), '其他用户')
  assert.equal(displayUserSender('', '张三丰', '我'), '我')
  assert.equal(displayUserSender('张三丰', '', '我'), '张三丰')
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
})
