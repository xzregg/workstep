import { useDigitalActivity } from './useDigitalActivity'
import { useI18n } from '../../i18n'
import './DigitalPersonActivity.css'
export default function DigitalPersonGrowth(){
 const data=useDigitalActivity(true),{t}=useI18n()
 if(!data)return null
 return <section className="digital-person-self-stats" aria-label={t('digitalPerson.selfStats')}>
  <div className="digital-person-growth"><strong>Lv.{data.level}</strong><progress value={data.experience} max={data.next_level_experience}/><span>{t('digitalPerson.experience',{count:data.experience,next:data.next_level_experience})}</span></div>
  <dl className="digital-person-stat-counts">
   <div><dt>{t('digitalPerson.sessionCount')}</dt><dd>{data.session_count ?? '—'}</dd></div>
   <div><dt>{t('digitalPerson.replyCount')}</dt><dd>{data.reply_count ?? '—'}</dd></div>
   <div><dt>{t('digitalPerson.taskCount')}</dt><dd>{data.task_count ?? '—'}</dd></div>
   <div><dt>{t('digitalPerson.completedTaskCount')}</dt><dd>{data.completed_task_count ?? '—'}</dd></div>
  </dl>
  <details className="digital-person-stat-skills"><summary>{t('digitalPerson.enabledSkills')}<span>{data.skills?.length ?? '—'}</span></summary>
   {data.skills?.length ? <ul>{data.skills.map(skill=><li key={skill.id}>{skill.name}</li>)}</ul> : <p>{t(data.skills ? 'digitalPerson.noEnabledSkills' : 'digitalPerson.statsUnavailable')}</p>}
  </details>
 </section>
}
