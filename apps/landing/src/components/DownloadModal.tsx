import { useState } from 'react'
import { Apple, Check, Copy, Monitor, Server } from 'lucide-react'
import { PLATFORM_DOWNLOADS, SOURCE_REPO_URL, SOURCE_START_COMMAND } from '../config/downloads'
import { useI18n } from '../i18n'
import { Modal } from './Modal'

const PLATFORM_ICONS = {
  macos: Apple,
  windows: Monitor,
  linux: Server,
} as const

export function DownloadModal({ onClose }: { onClose: () => void }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)

  const sourceCommands = `git clone ${SOURCE_REPO_URL}\ncd workstep\n${SOURCE_START_COMMAND}`

  const copySource = async () => {
    try {
      await navigator.clipboard.writeText(sourceCommands)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      setCopied(false)
    }
  }

  return (
    <Modal onClose={onClose} className="download-modal">
      <h3>{t('download.choosePlatform')}</h3>
      <div className="download-platforms">
        {PLATFORM_DOWNLOADS.map(({ key, url }) => {
          const Icon = PLATFORM_ICONS[key]
          const label = t(`download.${key}`)
          if (url) {
            return (
              <a key={key} className="download-platform" href={url} target="_blank" rel="noreferrer">
                <Icon size={22} />
                <span className="download-platform-name">{label}</span>
                <span className="download-platform-action">{t('common.download')}</span>
              </a>
            )
          }
          return (
            <div key={key} className="download-platform is-coming">
              <Icon size={22} />
              <span className="download-platform-name">{label}</span>
              <span className="download-platform-badge">{t('common.comingSoon')}</span>
            </div>
          )
        })}
      </div>
      <p className="download-platform-hint">{t('download.platformHint')}</p>

      <div className="download-source">
        <div className="download-source-head">
          <span>{t('download.sourceTitle')}</span>
          <button type="button" className="copy-btn" onClick={copySource}>
            {copied ? <Check size={13} /> : <Copy size={13} />}
            {copied ? t('common.copied') : t('common.copy')}
          </button>
        </div>
        <p className="download-source-desc">{t('download.sourceDesc')}</p>
        <pre className="code-block">
          <code>{sourceCommands}</code>
        </pre>
        <ol className="download-source-steps">
          <li>{t('download.sourceStep1')}</li>
          <li>{t('download.sourceStep2')}</li>
          <li>{t('download.sourceStep3')}</li>
        </ol>
      </div>
    </Modal>
  )
}
