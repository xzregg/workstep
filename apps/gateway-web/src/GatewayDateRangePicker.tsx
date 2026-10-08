import { useId } from 'react'
import { ConfigProvider, DatePicker } from 'antd'
import zhCN from 'antd/locale/zh_CN.js'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn.js'

type Range = { from_time: string; to_time: string }
export function GatewayDateRangePicker({ from, to, onChange, dateOnly = false, label = '时间范围' }: {
  from: string; to: string; dateOnly?: boolean; label?: string; onChange: (range: Range) => void
}) {
  const id = useId()
  return <div className="gateway-usage-date-field">
    <label htmlFor={id + '-from'}>{label}</label>
    <ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: '#1677ff', borderRadius: 8, controlHeight: 36 } }}>
      <DatePicker.RangePicker
        className="gateway-usage-date-range"
        classNames={{ popup: { root: 'gateway-usage-date-popup' } }}
        id={{ start: id + '-from', end: id + '-to' }}
        value={from && to ? [dayjs(from).locale('zh-cn'), dayjs(to).locale('zh-cn')] : null}
        format={dateOnly ? 'YYYY-MM-DD' : 'YYYY-MM-DD HH:mm'} showTime={dateOnly ? false : { format: 'HH:mm' }}
        placeholder={dateOnly ? ['对账开始日期', '对账结束日期'] : ['开始时间', '结束时间']}
        presets={[
          { label: '最近 7 天', value: () => [dayjs().subtract(7, 'day'), dayjs()] },
          { label: '最近一个月', value: () => [dayjs().subtract(1, 'month'), dayjs()] },
          { label: '本月', value: () => [dayjs().startOf('month'), dayjs()] },
          { label: '上月', value: () => [dayjs().subtract(1, 'month').startOf('month'), dayjs().startOf('month')] },
        ]}
        onChange={dates => onChange({ from_time: (dateOnly ? dates?.[0]?.format('YYYY-MM-DD') : dates?.[0]?.toISOString()) ?? '', to_time: (dateOnly ? dates?.[1]?.format('YYYY-MM-DD') : dates?.[1]?.toISOString()) ?? '' })}
      />
    </ConfigProvider>
  </div>
}
