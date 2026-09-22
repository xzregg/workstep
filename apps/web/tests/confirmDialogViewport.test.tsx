import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'

import ConfirmDialog from '../src/components/ConfirmDialog.tsx'
import { I18nProvider } from '../src/i18n/index.tsx'


test('confirm dialog keeps its chrome inside a short viewport and scrolls only its body', () => {
  const html = renderToStaticMarkup(
    <I18nProvider>
      <ConfirmDialog
        open
        title="分叉对话"
        confirmText="创建分支"
        onConfirm={() => {}}
        onCancel={() => {}}
      >
        <div style={{ height: 900 }}>很长的模型与聊天记录配置</div>
      </ConfirmDialog>
    </I18nProvider>,
  )

  assert.match(html, /max-height:calc\(100dvh - 32px\)/)
  assert.match(html, /display:flex;flex-direction:column;overflow:hidden/)
  assert.match(html, /data-confirm-dialog-body="true"[^>]*style="[^"]*overflow-y:auto/)
})
