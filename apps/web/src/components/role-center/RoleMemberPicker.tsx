import { useState } from 'react'
import type { RoleCatalog, TeamMember } from '../../api/roleCenter'
import Button from '../Button'
import Input from '../Input'
import Select from '../Select'
import { useI18n } from '../../i18n'

export default function RoleMemberPicker({ catalog, members, onChange, disabled }: {
  catalog: RoleCatalog; members: TeamMember[]; onChange: (members: TeamMember[]) => void; disabled: boolean
}) {
  const { t } = useI18n()
  const [category, setCategory] = useState('')
  const [query, setQuery] = useState('')
  const move = (index: number, offset: number) => {
    const next = [...members]
    ;[next[index], next[index + offset]] = [next[index + offset], next[index]]
    onChange(next)
  }
  const visible = catalog.roles.filter(role => (!category || role.category === category)
    && `${role.name} ${role.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  return <section className="role-center-member-picker" aria-label={t('roleCenter.members')}>
    <h2>{t('roleCenter.members')} · {members.length}</h2>
    <div className="role-center-selected-members">
      {members.map((member, index) => {
        const name = catalog.roles.find(r => r.id === member.role_id)?.name || member.role_id
        return <div key={member.role_id} className="role-center-member-row">
          <div className="role-center-member-heading"><strong>{index + 1}. {name}</strong><div>
            <Button size="sm" disabled={disabled || index === 0} aria-label={t('roleCenter.moveUp', { name })} onClick={() => move(index, -1)}>↑</Button>
            <Button size="sm" disabled={disabled || index === members.length - 1} aria-label={t('roleCenter.moveDown', { name })} onClick={() => move(index, 1)}>↓</Button>
          </div></div>
          <Input aria-label={t('roleCenter.dutyLabel', { name })} value={member.duty} disabled={disabled}
            maxLength={4000} placeholder={t('roleCenter.dutyPlaceholder')}
            onChange={event => onChange(members.map(m => m.role_id === member.role_id ? { ...m, duty: event.target.value } : m))} />
        </div>
      })}
    </div>
    <div className="role-center-member-filters">
      <Select value={category} disabled={disabled} aria-label={t('roleCenter.category')} onChange={event => setCategory(event.target.value)}>
        <option value="">{t('roleCenter.allRoles')}</option>{catalog.categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
      </Select>
      <Input aria-label={t('roleCenter.searchMembers')} value={query} disabled={disabled} placeholder={t('roleCenter.searchMembers')} onChange={event => setQuery(event.target.value)} />
    </div>
    <div className="role-center-member-options">
      {visible.map(role => <label key={role.id} className="role-center-member-option">
        <input type="checkbox" data-role-id={role.id} checked={members.some(m => m.role_id === role.id)} disabled={disabled}
          onChange={event => onChange(event.target.checked ? [...members, { role_id: role.id, duty: '' }] : members.filter(m => m.role_id !== role.id))} />
        <span><strong>{role.name}</strong><span>{role.description}</span></span>
      </label>)}
      {!visible.length && <p className="role-center-empty">{t('roleCenter.empty')}</p>}
    </div>
  </section>
}
