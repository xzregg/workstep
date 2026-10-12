import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { defaultSkin, effectiveSkinTokens, resolvedSkinLayout, type SkinDocument } from '../skins/contract'
import { useI18n } from '../i18n'
import Button from './Button'
import Input from './Input'
import Icon from './Icon'
import SkinStudioPreview from './SkinStudioPreview'

function SkinThumbnail({ skin }: { skin: SkinDocument }) {
  const tokens = effectiveSkinTokens(skin)
  const layout = resolvedSkinLayout(skin)
  const style = Object.fromEntries(['bg', 'surface', 'fg', 'border', 'accent'].map(key => [`--thumb-${key}`, tokens[key]])) as CSSProperties
  return <span className="skin-thumbnail" style={style} aria-hidden="true"><span className={`skin-thumbnail-window${layout.sidebarSide === 'right' ? ' is-right' : ''}`}><span className="skin-thumbnail-nav"><i /><i /><i /><i /></span><span className="skin-thumbnail-content"><span className="skin-thumbnail-title"><i /><b /></span><span className="skin-thumbnail-bubble"><i /><i /></span><span className="skin-thumbnail-bubble"><i /></span><span className="skin-thumbnail-composer" /></span></span></span>
}

export default function SkinLibrary({ documents, activeId, preferredSkin, busy, canManage, onCreate, onPreview, onApply, onExport, onDelete, onRestore }: {
  documents: SkinDocument[]; activeId: string; busy: boolean; canManage: boolean;
  preferredSkin?: SkinDocument | null;
  onCreate: (base?: SkinDocument) => void; onPreview: (skin: SkinDocument) => void; onApply: (skin: SkinDocument) => void;
  onExport: (id: string) => void; onDelete: (id: string) => void; onRestore: () => void;
}) {
  const { t } = useI18n()
  const [selectedId, setSelectedId] = useState(activeId)
  const consumedPreference = useRef<SkinDocument | null>(null)
  useEffect(() => {
    if (preferredSkin && consumedPreference.current !== preferredSkin && documents.some(skin => skin.manifest.id === preferredSkin.manifest.id && skin.revision === preferredSkin.revision)) {
      setSelectedId(preferredSkin.manifest.id); consumedPreference.current = preferredSkin
    }
  }, [documents, preferredSkin])
  const [filter, setFilter] = useState('all'), [query, setQuery] = useState('')
  const [phone, setPhone] = useState(false), [scene, setScene] = useState<'chat' | 'tasks' | 'flow'>('chat')
  const selected = documents.find(skin => skin.manifest.id === selectedId) ?? documents[0] ?? defaultSkin()
  const visible = documents.filter(skin => (filter !== 'mine' || skin.manifest.id !== 'default') && (filter !== 'active' || skin.manifest.id === activeId)
    && `${skin.manifest.name} ${skin.manifest.description ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()))
  return <>
    <div className="skin-settings-workspace">
      <section className="skin-settings-library">
        <div className="skin-settings-tabs" role="tablist" aria-label={t('skins.library')}>
          {(['all', 'mine', 'active'] as const).map(key => <button key={key} type="button" role="tab" aria-selected={filter === key} onClick={() => setFilter(key)}>{t(`skins.filter_${key}`)}{key !== 'active' && <small>{key === 'all' ? documents.length : documents.filter(skin => skin.manifest.id !== 'default').length}</small>}</button>)}
        </div>
        <label className="skin-settings-search"><Icon name="search" size={15} /><Input value={query} onChange={event => setQuery(event.target.value)} aria-label={t('skins.librarySearch')} placeholder={t('skins.librarySearch')} /></label>
        <div className="skin-settings-list">{visible.map(skin => <button type="button" key={skin.manifest.id} className="skin-settings-card" data-skin-id={skin.manifest.id} data-selected={selected.manifest.id === skin.manifest.id} aria-pressed={selected.manifest.id === skin.manifest.id} onClick={() => setSelectedId(skin.manifest.id)}>
          <SkinThumbnail skin={skin} /><span className="skin-settings-card-info"><span className="skin-settings-card-title"><strong>{skin.manifest.id === 'default' ? t('skins.default') : skin.manifest.name}</strong>{activeId === skin.manifest.id && <span className="skin-settings-pill">{t('skins.using')}</span>}</span><span className="skin-settings-card-meta">{t(skin.manifest.id === 'default' ? 'skins.builtIn' : 'skins.customPackage')} · {skin.manifest.version}</span><span className="skin-settings-swatches">{['bg', 'surface', 'accent', 'fg'].map(key => <i key={key} style={{ '--swatch-color': effectiveSkinTokens(skin)[key] } as CSSProperties} />)}</span></span>
        </button>)}
          {canManage && <button type="button" className="skin-settings-create-card" disabled={busy} onClick={() => onCreate()}><span><Icon name="sparkles" size={19} /></span><strong>{t('skins.create')}</strong><small>{t('skins.createHint')}</small></button>}
        </div>
        {visible.length === 0 && <p className="skin-settings-empty" role="status">{t('skins.empty')}</p>}
        <p className="skin-settings-library-tip"><Icon name="shield" size={13} />{t('skins.inheritanceHint')}</p>
      </section>
      <section className="skin-settings-detail">
        <header><div><div className="skin-settings-detail-title"><h2>{selected.manifest.id === 'default' ? t('skins.default') : selected.manifest.name}</h2>{activeId === selected.manifest.id && <span className="skin-settings-pill">{t('skins.using')}</span>}</div><p>{selected.manifest.description || t('skins.inheritanceHint')}</p></div><Button variant="icon" aria-label={t('skins.restore')} title={t('skins.restore')} onClick={onRestore}><Icon name="rotate-ccw" size={17} /></Button></header>
        <div className="skin-settings-preview-toolbar"><div className="skin-settings-device-tabs"><button type="button" aria-pressed={!phone} onClick={() => setPhone(false)}><Icon name="monitor" size={13} />PC</button><button type="button" aria-pressed={phone} onClick={() => setPhone(true)}><Icon name="smartphone" size={13} />{t('skins.studioPhone')}</button></div><div className="skin-settings-scene-tabs">{(['chat', 'tasks', 'flow'] as const).map(key => <button type="button" key={key} aria-pressed={scene === key} onClick={() => setScene(key)}>{t(`skins.scene_${key}`)}</button>)}</div></div>
        <div className="skin-settings-preview-stage"><SkinStudioPreview skin={selected} compact={phone} scene={scene} variant="center" /></div>
        <div className="skin-settings-preview-caption"><span><Icon name="check" size={12} />{t('skins.previewHint')}</span><span>{t(phone ? 'skins.mobileLayout' : 'skins.desktopLayout')}</span></div>
        <dl className="skin-settings-properties"><div><dt>{t('skins.colorScheme')}</dt><dd>{t(selected.manifest.color_scheme === 'dark' ? 'skins.dark' : 'skins.light')}</dd></div><div><dt>PC / {t('skins.studioPhone')}</dt><dd>{t('skins.independent')}</dd></div><div><dt>{t('skins.source')}</dt><dd>{t(selected.manifest.id === 'default' ? 'skins.builtIn' : 'skins.customPackage')}</dd></div><div><dt>{t('skins.version')}</dt><dd>{selected.manifest.version}</dd></div></dl>
        <footer><div className="skin-settings-actions">{canManage && <><Button variant="ghost" size="sm" disabled={busy} onClick={() => onCreate(selected)}><Icon name="sparkles" size={14} />{t('skins.customize')}</Button><Button variant="ghost" size="sm" disabled={busy || selected.manifest.id === 'default'} onClick={() => onExport(selected.manifest.id)}>{t('skins.export')}</Button>{selected.manifest.id !== 'default' && <Button variant="icon" disabled={busy} aria-label={t('skins.delete')} onClick={() => onDelete(selected.manifest.id)}><Icon name="trash" size={14} /></Button>}</>}</div><div className="skin-settings-actions"><Button size="sm" disabled={busy} onClick={() => onPreview(selected)}>{t('skins.preview')}</Button><Button size="sm" variant="primary" disabled={busy || activeId === selected.manifest.id} onClick={() => onApply(selected)}>{t(activeId === selected.manifest.id ? 'skins.applied' : 'skins.apply')}</Button></div></footer>
      </section>
    </div>
    <div className="skin-settings-footer-note"><span>{t('skins.deviceHint')}</span><Button variant="ghost" size="sm" onClick={onRestore}>{t('skins.restore')}</Button></div>
  </>
}
