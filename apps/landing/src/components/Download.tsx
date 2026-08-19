import { ArrowDownToLine, Terminal } from 'lucide-react'
import { useI18n } from '../i18n'

export function Download({ onOpen }: { onOpen: () => void }) {
  const { t } = useI18n()

  return (
    <section className="section section-alt" id="download">
      <div className="container download-grid">
        <div>
          <div className="section-eyebrow">{t('download.eyebrow')}</div>
          <h2 className="section-title">{t('download.title')}</h2>
          <p className="section-lede">{t('download.lede')}</p>
          <button type="button" className="btn btn-primary btn-lg" onClick={onOpen}>
            <ArrowDownToLine size={16} />
            {t('download.choosePlatform')}
          </button>
        </div>
        <div className="download-terminal-card">
          <div className="download-terminal-head">
            <Terminal size={15} />
            {t('download.sourceTitle')}
          </div>
          <pre className="code-block code-block-dark">
            <code>{`git clone workstep\ncd workstep\n./start.sh`}</code>
          </pre>
        </div>
      </div>
    </section>
  )
}
