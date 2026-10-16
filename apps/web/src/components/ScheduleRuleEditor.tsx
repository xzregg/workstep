import type { ScheduleRule } from '../api/client'
import { useI18n } from '../i18n'
import Field from './Field'
import Input from './Input'
import Select from './Select'
import './ScheduleRuleEditor.css'

/** The same frequency controls for project creation and task instructions. */
export default function ScheduleRuleEditor({ value: rule, onChange }: {
  value: ScheduleRule; onChange: (rule: ScheduleRule) => void
}) {
  const { t } = useI18n()
  const kind = rule.kind
  const changeKind = (kind: ScheduleRule['kind']) => {
    const common = {timezone:rule.timezone, start_date:rule.start_date, end_date:rule.end_date}
    const time = 'time' in rule ? rule.time : '09:00'
    const every = 'every' in rule ? rule.every : 1
    const weekdays = 'weekdays' in rule ? rule.weekdays : [1]
    if (kind === 'once') {
      const date = new Date(Date.now() + 3600000)
      onChange({kind,timezone:rule.timezone,run_at:new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16)})
    } else if (kind === 'minutes') onChange({...common,kind,every})
    else if (kind === 'daily') onChange({...common,kind,time})
    else if (kind === 'weekly') onChange({...common,kind,time,weekdays})
    else if (kind === 'monthly') onChange({...common,kind,time,monthdays:[1]})
    else if (kind === 'interval') onChange({...common,kind,every,unit:'hours',weekdays})
    else onChange({...common,kind:'cron',expression:'0 9 * * *'})
  }
  const weekdaysMeta = [
    [1,t('schedules.mon')], [2,t('schedules.tue')], [3,t('schedules.wed')],
    [4,t('schedules.thu')], [5,t('schedules.fri')], [6,t('schedules.sat')], [0,t('schedules.sun')],
  ] as Array<[number,string]>
  return <div className="schedule-frequency-section schedule-rule-editor">
    <div className="schedule-frequency-label">{t('schedules.frequency')}</div>
    <div className="schedule-frequency-tabs">
      <button type="button" className={kind!=='interval' && kind!=='once' ? 'active':''} onClick={()=>changeKind('daily')}>{t('schedules.frequencyCycle')}</button>
      <button type="button" className={kind==='interval' ? 'active':''} onClick={()=>changeKind('interval')}>{t('schedules.frequencyInterval')}</button>
      <button type="button" className={kind==='once' ? 'active':''} onClick={()=>changeKind('once')}>{t('schedules.frequencyOnce')}</button>
    </div>
    <div className="schedule-frequency-row">
      {kind!=='interval' && kind!=='once' && <Field><Select aria-label={t('schedules.frequency')} value={kind} onChange={event=>changeKind(event.target.value as ScheduleRule['kind'])}>
        <option value="minutes">{t('schedules.minuteInterval')}</option>
        <option value="daily">{t('schedules.daily')}</option>
        <option value="weekly">{t('schedules.weekly')}</option>
        <option value="monthly">{t('schedules.monthly')}</option>
        <option value="cron">Cron</option>
      </Select></Field>}
      {'time' in rule && <Field><Input aria-label={t('schedules.time')} type="time" value={rule.time} onChange={event=>onChange({...rule,time:event.target.value})} /></Field>}
      {(rule.kind==='minutes' || rule.kind==='interval') && <Field label={rule.kind==='interval' ? t('schedules.intervalHours'):undefined}><Input aria-label={t('schedules.every')} type="number" min={1} max={rule.kind==='minutes' ? 10080:24} value={rule.every} onChange={event=>onChange({...rule,every:Number(event.target.value)})} /></Field>}
      {rule.kind==='monthly' && <Field><Input aria-label={t('schedules.monthday')} type="number" min={1} max={31} value={rule.monthdays[0]} onChange={event=>onChange({...rule,monthdays:[Number(event.target.value)]})} /></Field>}
      {rule.kind==='cron' && <Field><Input aria-label="Cron" placeholder="0 9 * * 1-5" value={rule.expression} onChange={event=>onChange({...rule,expression:event.target.value})} /></Field>}
      {rule.kind==='once' && <Field className="schedule-rule-wide"><Input aria-label={t('schedules.runAt')} type="datetime-local" value={rule.run_at.slice(0,16)} onChange={event=>onChange({...rule,run_at:event.target.value})} /></Field>}
    </div>
    {'weekdays' in rule && <div className="schedule-weekday-tabs">{weekdaysMeta.map(([day,label])=><button key={day} type="button" className={rule.weekdays.includes(day) ? 'active':''} aria-pressed={rule.weekdays.includes(day)} onClick={()=>onChange({...rule,weekdays:rule.weekdays.includes(day) ? rule.weekdays.filter(item=>item!==day):[...rule.weekdays,day]})}>{label}</button>)}</div>}
    {kind!=='once' && <div className="schedule-effective-range">
      <div className="schedule-frequency-label">{t('schedules.effectiveRange')} <span>{t('schedules.effectiveRangeHint')}</span></div>
      <div className="schedule-date-range">
        <Input aria-label={t('schedules.startDate')} type="date" value={rule.start_date || ''} onChange={event=>onChange({...rule,start_date:event.target.value || undefined,end_date:rule.end_date && event.target.value>rule.end_date ? undefined:rule.end_date})} />
        <span>—</span>
        <Input aria-label={t('schedules.endDate')} type="date" min={rule.start_date || undefined} value={rule.end_date || ''} onChange={event=>onChange({...rule,end_date:event.target.value || undefined})} />
      </div>
    </div>}
  </div>
}
