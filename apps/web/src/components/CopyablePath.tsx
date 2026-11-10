import { useState } from 'react'
import { useI18n } from '../i18n'
import { copyText } from '../utils/clipboard'
import './CopyablePath.css'

export default function CopyablePath({ path }: { path: string }) {
  const { t } = useI18n()
  const [result, setResult] = useState<{ path: string; ok: boolean } | null>(null)
  const notice = result?.path === path
    ? t(result.ok ? 'common.copied' : 'meta.copyFailed')
    : ''

  return (
    <button
      type="button"
      className="copyable-path"
      title={path}
      aria-label={`${t('fileMenu.copyPath')}: ${path}`}
      onClick={async () => setResult({ path, ok: await copyText(path) })}
    >
      <span className="copyable-path-text">{path}</span>
      <span className="copyable-path-status" role="status">{notice}</span>
    </button>
  )
}
