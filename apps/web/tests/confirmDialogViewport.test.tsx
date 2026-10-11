import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
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

  const css = readFileSync(new URL('../src/components/ConfirmDialog.css', import.meta.url), 'utf8')
  assert.match(html, /class="confirm-dialog-panel resizable-panel"/)
  assert.match(html, /data-confirm-dialog-body="true" class="confirm-dialog-body"/)
  assert.match(css, /\.confirm-dialog-panel\s*\{[^}]*max-height:\s*calc\(100dvh - 32px\)[^}]*display:\s*flex;\s*flex-direction:\s*column;\s*overflow:\s*hidden/)
  assert.match(css, /\.confirm-dialog-body\s*\{[^}]*min-height:\s*0;\s*overflow-y:\s*auto/)
})
