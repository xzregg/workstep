import { useI18n } from '../i18n'
import { modelDownloading, type VoiceModelInstall } from '../api/speechModelInstall'
import Button from './Button'
import { formatVoiceModelSize } from './VoiceModelMirror'

export function VoiceModelSavedDownload({ install }: { install: VoiceModelInstall }) {
  const { t } = useI18n()
  const bytes = install.partial_bytes ?? 0
  return !modelDownloading(install) && bytes > 0 ? <p>{t('voiceModel.retained', { size: formatVoiceModelSize(bytes) })}</p> : null
}

export default function VoiceModelDownloadActions({ install, downloadLabel, disabled, startDisabled, onDownload, onPause, onDiscard }: {
  install: VoiceModelInstall
  downloadLabel?: string
  disabled: boolean
  startDisabled: boolean
  onDownload: () => void
  onPause: () => void
  onDiscard: () => void
}) {
  const { t } = useI18n()
  const retained = (install.partial_bytes ?? 0) > 0
  if (modelDownloading(install)) return <Button disabled={disabled} onClick={onPause}>{t('voiceModel.pause')}</Button>
  return <>
    {downloadLabel && <Button disabled={disabled || startDisabled} onClick={onDownload}>{retained ? t('voiceModel.resume') : downloadLabel}</Button>}
    {retained && <Button disabled={disabled} onClick={onDiscard}>{t('voiceModel.discard')}</Button>}
  </>
}
