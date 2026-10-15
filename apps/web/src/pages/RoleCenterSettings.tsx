import { useEffect, useState } from 'react'
import Button from '../components/Button'
import Icon from '../components/Icon'
import Input from '../components/Input'
import Spinner from '../components/Spinner'
import PromptAssetEditor from '../components/role-center/PromptAssetEditor'
import { roleCenterApi, type RoleCatalog, type RoleDocument, type TeamDocument } from '../api/roleCenter'
import { useI18n } from '../i18n'
import './RoleCenterSettings.css'

export default function RoleCenterSettings({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) {
  const { t } = useI18n()
  const [catalog, setCatalog] = useState<RoleCatalog | null>(null)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const [view, setView] = useState<'roles' | 'teams'>('roles')
  const [category, setCategory] = useState('')
  const [query, setQuery] = useState('')
  const [editing, setEditing] = useState<{ kind: 'role' | 'team'; id: string | null } | null>(null)

  useEffect(() => {
    let active = true
    setError('')
    roleCenterApi.catalog().then(result => { if (active) setCatalog(result) })
      .catch(reason => { if (active) setError(String(reason instanceof Error ? reason.message : reason)) })
    return () => { active = false }
  }, [revision])

  const categories = catalog?.categories || []
  const categoryName = (id: string) => categories.find(c => c.id === id)?.name || id
  const roles = catalog?.roles || [], teams = catalog?.teams || []
  const text = query.trim().toLocaleLowerCase()
  const filteredRoles = roles.filter(r => (!category || category === 'custom' && !r.builtin || r.category === category)
    && `${r.name} ${r.description} ${categoryName(r.category)}`.toLocaleLowerCase().includes(text))
  const filteredTeams = teams.filter(team => `${team.name} ${team.description}`.toLocaleLowerCase().includes(text))
  const saved = (record: RoleDocument | TeamDocument) => {
    setCatalog(current => {
      if (!current) return current
      const { prompt: _prompt, ...summary } = record
      if ('category' in summary) {
        const nextCategories = current.categories.some(c => c.id === summary.category) ? current.categories
          : [...current.categories, { id: summary.category, name: summary.category }]
        return { ...current, categories: nextCategories, roles: [...current.roles.filter(r => r.id !== record.id), summary] }
      }
      return { ...current, teams: [...current.teams.filter(team => team.id !== record.id), summary] }
    })
    setEditing(null)
  }

  return <div className="role-center">
    <header className="role-center-header"><div><h1>{t('roleCenter.title')}</h1>
      <p>{t('roleCenter.intro')}</p></div>
      <Button variant="primary" disabled={!catalog} onClick={() => setEditing({ kind: view === 'roles' ? 'role' : 'team', id: null })}>
        <Icon name="plus" size={16} />{t(view === 'roles' ? 'roleCenter.newRole' : 'roleCenter.newTeam')}
      </Button>
    </header>
    <div className="role-center-tabs" role="tablist" aria-label={t('roleCenter.title')}>
      {(['roles', 'teams'] as const).map(item => <button key={item} type="button" role="tab"
        id={`role-center-${item}-tab`} aria-controls="role-center-library" aria-selected={view === item}
        aria-label={t(item === 'roles' ? 'roleCenter.roles' : 'roleCenter.teams')}
        onClick={() => { setView(item); setQuery('') }}>
        {t(item === 'roles' ? 'roleCenter.roles' : 'roleCenter.teams')}<span>{item === 'roles' ? roles.length : teams.length}</span>
      </button>)}
    </div>
    {error && <div className="role-center-error" role="alert">{error}<Button onClick={() => setRevision(r => r + 1)}>{t('roleCenter.retry')}</Button></div>}
    {!catalog && !error && <div className="role-center-loading"><Spinner />{t('roleCenter.loading')}</div>}
    {catalog && <div className="role-center-workspace">
      <aside className="role-center-categories" aria-label={t('roleCenter.category')}>
        {view === 'roles' ? [{ id: '', name: t('roleCenter.allRoles') }, ...categories, { id: 'custom', name: t('roleCenter.custom') }]
          .map(item => <button type="button" key={item.id} aria-pressed={category === item.id} onClick={() => setCategory(item.id)}>{item.name}</button>)
          : <p>{t('roleCenter.teamHint')}</p>}
      </aside>
      <section className="role-center-library" id="role-center-library" role="tabpanel" aria-labelledby={`role-center-${view}-tab`}>
        <Input aria-label={t(view === 'roles' ? 'roleCenter.searchRoles' : 'roleCenter.searchTeams')}
          placeholder={t(view === 'roles' ? 'roleCenter.searchRoles' : 'roleCenter.searchTeams')}
          value={query} onChange={event => setQuery(event.target.value)} />
        {catalog.warnings.length > 0 && <p className="role-center-error" role="alert">{t('roleCenter.fileWarning', { count: catalog.warnings.length })}</p>}
        <div className="role-center-cards">
          {view === 'roles' ? filteredRoles.map(role => <button type="button" className="role-center-card" key={role.id}
            aria-label={t('roleCenter.editRoleLabel', { name: role.name })} onClick={() => setEditing({ kind: 'role', id: role.id })}>
            <span className="role-center-card-title">{role.name}</span><span className="role-center-card-category">{categoryName(role.category)}</span>
            <span className="role-center-card-description">{role.description}</span><span className="role-center-card-footer">
              {t(role.builtin ? 'roleCenter.builtin' : 'roleCenter.custom')}
              <span>{t('roleCenter.teamReferences', { count: teams.filter(team => team.members.some(m => m.role_id === role.id)).length })}</span>
            </span>
          </button>) : filteredTeams.map(team => <button type="button" className="role-center-card" key={team.id}
            aria-label={t('roleCenter.editTeamLabel', { name: team.name })} onClick={() => setEditing({ kind: 'team', id: team.id })}>
            <span className="role-center-card-title">{team.name}</span><span className="role-center-card-description">{team.description}</span>
            <span className="role-center-team-members">{team.members.map(m => roles.find(r => r.id === m.role_id)?.name || m.role_id).join(' · ')}</span>
            <span className="role-center-card-footer">{t('roleCenter.memberCount', { count: team.members.length })}</span>
          </button>)}
        </div>
        {(view === 'roles' ? filteredRoles : filteredTeams).length === 0 && <p className="role-center-empty">{t('roleCenter.empty')}</p>}
      </section>
    </div>}
    {editing && catalog && <PromptAssetEditor key={`${editing.kind}:${editing.id}`} kind={editing.kind} id={editing.id}
      catalog={catalog} onSaved={saved} onClose={() => setEditing(null)} onDirtyChange={onDirtyChange} />}
  </div>
}
