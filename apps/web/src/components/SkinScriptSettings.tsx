import './SkinScriptSettings.css'
import { useId } from 'react'
import { useI18n } from '../i18n'
import type { SkinDocument } from '../skins/contract'
import { setSkinScriptsEnabled, useSkinScriptsEnabled } from '../skins/scriptPreferences'

export default function SkinScriptSettings({ skin }: { skin: SkinDocument }) {
  const { t } = useI18n()
  const enabled = useSkinScriptsEnabled(skin)
  const descriptionId = useId()
  return <div className="skin-script-settings">
    <div><strong>{t('skinExtensions.runScripts')}</strong><p id={descriptionId}>{t(skin.script ? 'skinExtensions.scriptHint' : 'skinExtensions.noScript')}</p></div>
    <button type="button" className="settings-switch" role="switch" aria-label={t('skinExtensions.runScripts')}
      aria-describedby={descriptionId} aria-checked={enabled} disabled={!skin.script}
      onClick={() => setSkinScriptsEnabled(skin, !enabled)}><span className="settings-switch-thumb" /></button>
  </div>
}
