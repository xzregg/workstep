import * as React from 'react'
import type { CSSProperties } from 'react'

export type ActivityDay = { date: string; count: number; tokens: number | null }
export type ActivityLabels = { title: string; previous: string; next: string; less: string; more: string; outside: string; unknown: string; calls: string; days: string; hint: string }
const dateKey = (date: Date) => date.toISOString().slice(0, 10)
/** Convert an exclusive instant range into calendar dates in the report timezone. */
export function activityDateRange(start: string, end: string, timeZone = 'UTC') {
 const format = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
 const first = format.format(new Date(start))
 const last = format.format(new Date(Date.parse(end) - 1))
 return { start: first, end: dateKey(new Date(Date.parse(last + 'T00:00:00Z') + 86400000)) }
}

export function activityCalendar(year: number, rows: ActivityDay[], start: string, end: string) {
 const first = new Date(Date.UTC(year, 0, 1))
 const offset = (first.getUTCDay() + 6) % 7
 const byDate = new Map(rows.map(row => [row.date, row]))
 const result = []
 for (let date = first, index = 0; date.getUTCFullYear() === year; index++, date = new Date(Date.UTC(year, 0, index + 1))) {
  const key = dateKey(date)
  result.push({ date: key, count: 0, tokens: 0 as number | null, ...byDate.get(key), slot: index + offset, outside: key < start || key >= end })
 }
 return result
}

function YearChevron({ next = false }: { next?: boolean }) {
 return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={next ? 'M6 4l4 4-4 4' : 'M10 4L6 8l4 4'}/></svg>
}

export function ActivityHeatmap({ rows, start, end, locale = 'zh-CN', labels }: {
 rows: ActivityDay[]; start: string; end: string; locale?: string; labels: ActivityLabels
}) {
 const minYear = Number(start.slice(0, 4))
 const maxYear = new Date(Date.parse(end.slice(0, 10) + 'T00:00:00Z') - 1).getUTCFullYear()
 const [selectedYear, setYear] = React.useState(maxYear)
 const year = Math.max(minYear, Math.min(maxYear, selectedYear))
 const [active, setActive] = React.useState<string | null>(null)
 const days = activityCalendar(year, rows, start, end)
 const visible = days.filter(day => !day.outside)
 const maximum = Math.max(1, ...visible.map(day => day.count))
 const total = visible.reduce((sum, day) => sum + day.count, 0)
 const number = (value: number) => value.toLocaleString(locale)
 const describe = (day: typeof days[number]) => day.outside ? `${day.date} · ${labels.outside}`
  : `${day.date} · ${number(day.count)} ${labels.calls} · ${day.tokens === null ? labels.unknown : number(day.tokens)} tokens`
 const detail = days.find(day => day.date === active)
 const columns = Math.ceil((days.at(-1)!.slot + 1) / 7)
 return <section className="activity-heatmap" aria-label={labels.title}>
  <div className="activity-heatmap-heading"><h3>{labels.title}</h3><span>{labels.days} {number(visible.filter(day => day.count > 0).length)} · {number(total)} {labels.calls}</span>
   <div className="activity-heatmap-years"><button type="button" aria-label={labels.previous} disabled={year <= minYear} onClick={() => { setYear(year - 1); setActive(null) }}><YearChevron/></button><strong>{year}</strong><button type="button" aria-label={labels.next} disabled={year >= maxYear} onClick={() => { setYear(year + 1); setActive(null) }}><YearChevron next/></button></div>
  </div>
  <div className="activity-heatmap-scroll"><div className="activity-heatmap-calendar" style={{ '--activity-columns': columns } as CSSProperties}>
   <div className="activity-heatmap-months">{Array.from({length:12}, (_, month) => {
    const day = days.find(day => day.date.endsWith(`-${String(month + 1).padStart(2,'0')}-01`))!
    return <span key={month} style={{gridColumn: Math.floor(day.slot / 7) + 1}}>{new Intl.DateTimeFormat(locale, {month:'short', timeZone:'UTC'}).format(new Date(Date.UTC(year, month, 1)))}</span>
   })}</div>
   <div className="activity-heatmap-weekdays">{[0,2,4].map(day => <span key={day} style={{gridRow:day + 1}}>{new Intl.DateTimeFormat(locale, {weekday:'short', timeZone:'UTC'}).format(new Date(Date.UTC(2024,0,1 + day)))}</span>)}</div>
   <div className="activity-heatmap-cells" onPointerLeave={() => setActive(null)}>{days.map(day => <button type="button" key={day.date} data-date={day.date} data-outside={day.outside} data-level={day.outside || day.count === 0 ? 0 : Math.min(4, Math.ceil(day.count / maximum * 4))}
    style={{gridColumn:Math.floor(day.slot / 7) + 1, gridRow:day.slot % 7 + 1}} aria-label={describe(day)} title={describe(day)}
    onPointerEnter={() => setActive(day.date)} onFocus={() => setActive(day.date)} onBlur={() => setActive(null)} onClick={() => setActive(day.date)}/>)}</div>
  </div></div>
  <div className="activity-heatmap-footer"><span role={detail ? "status" : undefined}>{detail ? describe(detail) : labels.hint}</span><span className="activity-heatmap-legend">{labels.less}{[0,1,2,3,4].map(level => <i key={level} data-level={level}/>)}{labels.more}</span></div>
 </section>
}
