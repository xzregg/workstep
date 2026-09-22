import { useEffect, useMemo, useState } from 'react'
import Button from '../components/Button'
import Icon from '../components/Icon'
import Spinner from '../components/Spinner'
import Select from '../components/Select'
import { skillApi, type Project, type SkillDescriptor } from '../api/client'
import { useI18n } from '../i18n'

type SourceFilter = 'all' | 'agents' | 'claude' | 'codex' | 'project'

const sourceLabels: Record<Exclude<SourceFilter, 'all'>, string> = {
  agents: '~/.agents',
  claude: '~/.claude',
  codex: '~/.codex',
  project: '.workstep',
}

export default function SkillCenterSettings({
  project,
  embedded = false,
}: {
  project: Project | null
  embedded?: boolean
}) {
  const { t } = useI18n()
  const [skills, setSkills] = useState<SkillDescriptor[]>([])
  const [search, setSearch] = useState('')
  const [source, setSource] = useState<SourceFilter>('all')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [updating, setUpdating] = useState<string | null>(null)
  const [batchAction, setBatchAction] = useState<'enable' | 'disable' | null>(null)
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(new Set())

  const available = Boolean(project && project.type !== 'remote')

  const load = async (rescan = false) => {
    if (!project || !available) return
    setLoading(true)
    setError('')
    try {
      const result = rescan
        ? await skillApi.rescan(project.id)
        : await skillApi.list(project.id)
      setSkills(result.skills)
      setSelectedSkillIds(new Set())
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('skillCenter.loadFailed'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    setSkills([])
    setSearch('')
    setSource('all')
    setError('')
    setSelectedSkillIds(new Set())
    void load()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id, available])

  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase()
    return skills.filter((skill) => {
      if (source !== 'all' && skill.source !== source) return false
      if (!query) return true
      return `${skill.name}\n${skill.description}\n${skill.source_path}`
        .toLocaleLowerCase()
        .includes(query)
    })
  }, [search, skills, source])

  const selectableFiltered = useMemo(
    () => filtered.filter((skill) => skill.valid),
    [filtered],
  )
  const allFilteredSelected = selectableFiltered.length > 0
    && selectableFiltered.every((skill) => selectedSkillIds.has(skill.skill_id))

  const selectAllFiltered = () => {
    setSelectedSkillIds((current) => {
      const next = new Set(current)
      if (allFilteredSelected) {
        selectableFiltered.forEach((skill) => next.delete(skill.skill_id))
      } else {
        selectableFiltered.forEach((skill) => next.add(skill.skill_id))
      }
      return next
    })
  }

  const toggleSelected = (skillId: string) => {
    setSelectedSkillIds((current) => {
      const next = new Set(current)
      if (next.has(skillId)) next.delete(skillId)
      else next.add(skillId)
      return next
    })
  }

  const batchSetEnabled = async (enabled: boolean) => {
    if (!project || batchAction || updating || selectedSkillIds.size === 0) return
    const previous = skills
    setBatchAction(enabled ? 'enable' : 'disable')
    setError('')
    try {
      const result = await skillApi.setEnabledBatch(
        project.id,
        Array.from(selectedSkillIds),
        enabled,
      )
      setSkills(result.skills)
      setSelectedSkillIds(new Set())
    } catch (reason) {
      setSkills(previous)
      setError(reason instanceof Error ? reason.message : t('skillCenter.batchUpdateFailed'))
    } finally {
      setBatchAction(null)
    }
  }

  const toggle = async (skill: SkillDescriptor) => {
    if (!project || updating) return
    const previous = skills
    const nextEnabled = !skill.enabled
    setUpdating(skill.skill_id)
    setError('')
    setSkills((current) => current.map((item) => {
      if (item.skill_id === skill.skill_id) return { ...item, enabled: nextEnabled }
      if (nextEnabled && item.name === skill.name) return { ...item, enabled: false }
      return item
    }))
    try {
      const result = await skillApi.setEnabled(project.id, skill.skill_id, nextEnabled)
      setSkills(result.skills)
    } catch (reason) {
      setSkills(previous)
      setError(reason instanceof Error ? reason.message : t('skillCenter.updateFailed'))
    } finally {
      setUpdating(null)
    }
  }

  if (!project) {
    return (
      <div style={{ maxWidth: 800, margin: '0 auto' }}>
        <h1 style={{ fontSize: 'calc(20px * var(--font-scale))', fontWeight: 650, marginBottom: 6 }}>
          {t('skillCenter.title')}
        </h1>
        <div style={{ marginTop: 28, padding: '34px 24px', textAlign: 'center', color: 'var(--muted)', border: '1px solid var(--border-soft)', borderRadius: 14 }}>
          <Icon name="folder" size={24} />
          <p style={{ marginTop: 12, fontWeight: 600, color: 'var(--fg)' }}>{t('skillCenter.noProject')}</p>
          <p style={{ marginTop: 5, fontSize: 'calc(13px * var(--font-scale))' }}>{t('skillCenter.noProjectHint')}</p>
        </div>
      </div>
    )
  }

  return (
    <div style={{ maxWidth: embedded ? undefined : 800, margin: embedded ? 0 : '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 20 }}>
        <div style={{ flex: 1 }}>
          {!embedded && (
            <h1 style={{ fontSize: 'calc(20px * var(--font-scale))', fontWeight: 650, marginBottom: 6 }}>
              {t('skillCenter.title')}
            </h1>
          )}
          <p style={{ color: 'var(--muted)', fontSize: 'calc(13px * var(--font-scale))', lineHeight: 1.55 }}>
            {t('skillCenter.intro')}
          </p>
        </div>
        <Button onClick={() => void load(true)} loading={loading} disabled={!available}>
          <Icon name="refresh" size={14} />
          {t('skillCenter.rescan')}
        </Button>
      </div>

      <div className="skill-center-project-summary" style={{ padding: '12px 14px', marginBottom: 16, borderRadius: 12, background: 'var(--surface)', border: '1px solid var(--border-soft)' }}>
        <div style={{ fontWeight: 600, fontSize: 'calc(13px * var(--font-scale))' }}>{project.name}</div>
        <div title={project.path} style={{ marginTop: 3, color: 'var(--meta)', fontSize: 'calc(11px * var(--font-scale))', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.path}</div>
        <div style={{ marginTop: 7, color: 'var(--muted)', fontSize: 'calc(12px * var(--font-scale))' }}>
          {available ? t('skillCenter.nextRunHint') : t('skillCenter.remoteUnsupported')}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(150px, 180px)', alignItems: 'end', gap: 12, marginBottom: 14 }}>
        <label style={{ display: 'grid', gap: 6, minWidth: 0 }}>
          <span style={{ fontSize: 'calc(12px * var(--font-scale))', fontWeight: 600 }}>{t('skillCenter.search')}</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('skillCenter.searchPlaceholder')}
            style={{ width: '100%', padding: '0 12px' }}
          />
        </label>
        <label style={{ display: 'grid', gap: 6 }}>
          <span style={{ fontSize: 'calc(12px * var(--font-scale))', fontWeight: 600 }}>{t('skillCenter.sourceFilter')}</span>
          <Select value={source} onChange={(event) => setSource(event.target.value as SourceFilter)} style={{ width: '100%', padding: '0 10px' }}>
            <option value="all">{t('skillCenter.allSources')}</option>
            {Object.entries(sourceLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </Select>
        </label>
      </div>

      {error && <div role="alert" style={{ marginBottom: 12, padding: '10px 12px', borderRadius: 10, color: 'var(--danger)', background: 'color-mix(in oklab, var(--danger), transparent 91%)' }}>{error}</div>}

      {!loading && available && filtered.length === 0 ? (
        <div style={{ padding: '32px 20px', textAlign: 'center', color: 'var(--muted)' }}>
          {skills.length ? t('skillCenter.noMatches') : t('skillCenter.empty')}
        </div>
      ) : (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: '28px minmax(0, 1fr) auto', alignItems: 'center', gap: 12, minHeight: 46, padding: '0 2px', borderTop: '1px solid var(--border-soft)', borderBottom: '1px solid var(--border-soft)' }}>
            <input
              type="checkbox"
              checked={allFilteredSelected}
              disabled={!available || selectableFiltered.length === 0 || Boolean(batchAction) || Boolean(updating)}
              aria-label={allFilteredSelected ? t('skillCenter.clearFiltered') : t('skillCenter.selectFiltered')}
              onChange={selectAllFiltered}
              style={{ width: 18, height: 18, margin: 0, accentColor: 'var(--accent)' }}
            />
            <span style={{ color: 'var(--muted)', fontSize: 'calc(12px * var(--font-scale))' }}>
              {selectedSkillIds.size > 0
                ? t('skillCenter.selectedCount', { count: selectedSkillIds.size })
                : t('skillCenter.selectFiltered')}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8 }}>
              <Button size="sm" onClick={() => void batchSetEnabled(true)} disabled={selectedSkillIds.size === 0 || Boolean(batchAction) || Boolean(updating)} loading={batchAction === 'enable'}>
                {t('skillCenter.enableSelected')}
              </Button>
              <Button size="sm" onClick={() => void batchSetEnabled(false)} disabled={selectedSkillIds.size === 0 || Boolean(batchAction) || Boolean(updating)} loading={batchAction === 'disable'}>
                {t('skillCenter.disableSelected')}
              </Button>
            </div>
          </div>
          {filtered.map((skill) => {
            const problem = skill.error || skill.sync_error
            const busy = updating === skill.skill_id
            return (
              <div key={skill.skill_id} style={{ display: 'grid', gridTemplateColumns: '28px minmax(0, 1fr) 132px', alignItems: 'start', gap: 12, padding: '17px 2px', borderBottom: '1px solid var(--border-soft)' }}>
                <input
                  type="checkbox"
                  checked={selectedSkillIds.has(skill.skill_id)}
                  disabled={!available || !skill.valid || Boolean(batchAction) || Boolean(updating)}
                  aria-label={t('skillCenter.selectSkill', { name: skill.name })}
                  onChange={() => toggleSelected(skill.skill_id)}
                  style={{ width: 18, height: 18, margin: '2px 0 0', accentColor: 'var(--accent)' }}
                />
                <div style={{ minWidth: 0 }}>
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 7 }}>
                    <span style={{ fontWeight: 650 }}>{skill.name}</span>
                    <span style={{ padding: '2px 7px', borderRadius: 999, background: 'var(--surface)', color: 'var(--muted)', fontSize: 'calc(11px * var(--font-scale))' }}>{sourceLabels[skill.source as Exclude<SourceFilter, 'all'>] || skill.source}</span>
                    {skill.conflict && <span style={{ color: 'var(--warning)', fontSize: 'calc(11px * var(--font-scale))' }}>{t('skillCenter.conflict')}</span>}
                    {skill.enabled && skill.sync_status === 'synced' && <span style={{ color: 'var(--success)', fontSize: 'calc(11px * var(--font-scale))' }}>{t('skillCenter.synced')}</span>}
                  </div>
                  <p style={{ marginTop: 6, color: 'var(--muted)', fontSize: 'calc(13px * var(--font-scale))', lineHeight: 1.5 }}>{skill.description || t('skillCenter.noDescription')}</p>
                  <div title={skill.source_path} style={{ marginTop: 6, color: 'var(--meta)', fontSize: 'calc(11px * var(--font-scale))', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{skill.source_path}</div>
                  {problem && <div role="status" style={{ marginTop: 7, color: 'var(--danger)', fontSize: 'calc(12px * var(--font-scale))' }}>{problem}</div>}
                </div>
                <label style={{ display: 'grid', gridTemplateColumns: '72px 36px', alignItems: 'center', justifyContent: 'end', gap: 10, minHeight: 22, color: 'var(--muted)', fontSize: 'calc(12px * var(--font-scale))' }}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'flex-end', gap: 5, textAlign: 'right' }}>
                    {busy && <Spinner size={12} />}
                    {skill.enabled ? t('skillCenter.enabled') : t('skillCenter.disabled')}
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={skill.enabled}
                    disabled={!available || !skill.valid || Boolean(updating) || Boolean(batchAction)}
                    aria-label={`${skill.name} ${skill.enabled ? t('skillCenter.disable') : t('skillCenter.enable')}`}
                    onChange={() => void toggle(skill)}
                    style={{ width: 36, height: 20, accentColor: 'var(--accent)', cursor: busy ? 'wait' : 'pointer' }}
                  />
                </label>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
