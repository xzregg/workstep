import assert from 'node:assert/strict'
import test from 'node:test'

import {
  displayUserDetail,
  displayUserSender,
  isSameActorName,
} from '../src/utils/actorDisplay'

test('same actor names are normalized before comparison', () => {
  assert.equal(isSameActorName(' 谢钊荣 ', '谢钊荣'), true)
  assert.equal(isSameActorName('谢钊荣', '其他用户'), false)
  assert.equal(isSameActorName('', '谢钊荣'), false)
})

test('the current user is displayed as me', () => {
  assert.equal(displayUserSender('谢钊荣', '谢钊荣', '我'), '我')
  assert.equal(displayUserSender('其他用户', '谢钊荣', '我'), '其他用户')
  assert.equal(displayUserSender('', '谢钊荣', '我'), '我')
  assert.equal(displayUserSender('谢钊荣', '', '我'), '谢钊荣')
})

test('hover detail keeps the original author name instead of the me label', () => {
  assert.equal(
    displayUserDetail('谢钊荣', 'MacBook Pro', '我'),
    '谢钊荣 · MacBook Pro',
  )
  assert.equal(
    displayUserDetail('其他用户', 'Windows PC', '我'),
    '其他用户 · Windows PC',
  )
  assert.equal(displayUserDetail('', 'MacBook Pro', '我'), '我 · MacBook Pro')
  assert.equal(displayUserDetail('谢钊荣', '', '我'), '谢钊荣')
})
