import assert from 'node:assert/strict'
import test from 'node:test'
import {
  conversationBottomScrollTop,
  isAutoShrinkClamp,
  isNearConversationBottom,
  shouldPauseConversationFollow,
} from '../src/utils/conversationScroll'

test('only follows new messages while the reader stays near the bottom', () => {
  assert.equal(isNearConversationBottom(1000, 620, 300), true)
  assert.equal(isNearConversationBottom(1000, 300, 300), false)
})

test('pauses message following as soon as the reader navigates toward older messages', () => {
  assert.equal(shouldPauseConversationFollow({ type: 'wheel', deltaY: -1 }), true)
  assert.equal(shouldPauseConversationFollow({ type: 'wheel', deltaY: 1 }), false)
  assert.equal(shouldPauseConversationFollow({ type: 'key', key: 'ArrowUp' }), true)
  assert.equal(shouldPauseConversationFollow({ type: 'key', key: 'PageUp' }), true)
  assert.equal(shouldPauseConversationFollow({ type: 'key', key: 'Home' }), true)
  assert.equal(shouldPauseConversationFollow({ type: 'key', key: 'ArrowDown' }), false)
})

test('conversationBottomScrollTop pins to the bottom without going negative', () => {
  assert.equal(conversationBottomScrollTop(500, 300), 200)
  assert.equal(conversationBottomScrollTop(200, 300), 0)
  assert.equal(conversationBottomScrollTop(0, 0), 0)
})

test('treats a bottom-landing scroll as an auto shrink clamp, not a user scroll-up', () => {
  // 思考块折叠：内容从 1000 缩到 600，scrollTop 被浏览器钳制到新的底部 300。
  assert.equal(isAutoShrinkClamp({
    scrollTop: 300,
    prevScrollTop: 700,
    scrollHeight: 600,
    prevScrollHeight: 1000,
    clientHeight: 300,
  }), true)
  // 用户滚轮上滚：scrollTop 减小但内容高度不变 → 手动滚动。
  assert.equal(isAutoShrinkClamp({
    scrollTop: 650,
    prevScrollTop: 700,
    scrollHeight: 1000,
    prevScrollHeight: 1000,
    clientHeight: 300,
  }), false)
  // 内容撑大、scrollTop 不变：没有滚动发生。
  assert.equal(isAutoShrinkClamp({
    scrollTop: 700,
    prevScrollTop: 700,
    scrollHeight: 1200,
    prevScrollHeight: 1000,
    clientHeight: 300,
  }), false)
  // 高度缩小、scrollTop 也减小但位置未落底（合成兜底分支）：不按自动钳制处理。
  assert.equal(isAutoShrinkClamp({
    scrollTop: 200,
    prevScrollTop: 700,
    scrollHeight: 600,
    prevScrollHeight: 1000,
    clientHeight: 300,
  }), false)
  // 向下滚动一律不是上滚钳制。
  assert.equal(isAutoShrinkClamp({
    scrollTop: 750,
    prevScrollTop: 700,
    scrollHeight: 1000,
    prevScrollHeight: 1000,
    clientHeight: 300,
  }), false)
})
