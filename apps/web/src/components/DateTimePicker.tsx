import { ConfigProvider, DatePicker } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import zhTW from 'antd/locale/zh_TW'
import enUS from 'antd/locale/en_US'
import jaJP from 'antd/locale/ja_JP'
import dayjs, { type Dayjs } from 'dayjs'
import 'dayjs/locale/zh-cn'
import 'dayjs/locale/zh-tw'
import 'dayjs/locale/en'
import 'dayjs/locale/ja'
import { useEffect } from 'react'
import { useI18n } from '../i18n'

interface DateTimePickerProps {
  value: string
  min?: string
  onChange: (value: string) => void
  disabled?: boolean
}

function parseLocalValue(value: string): Dayjs | null {
  if (!value) return null
  const date = dayjs(value)
  return date.isValid() ? date : null
}

export default function DateTimePicker({ value, min, onChange, disabled }: DateTimePickerProps) {
  const { t, locale } = useI18n()
  const selected = parseLocalValue(value)
  const minimum = parseLocalValue(min || '')
  // Keep Ant Design's calendar, time panel, clear button and “now” action
  // in sync with WorkStep's language setting, not just the outer placeholder.
  const antdLocale = locale === 'en-US' ? enUS
    : locale === 'zh-TW' ? zhTW
      : locale === 'ja-JP' ? jaJP
        : zhCN
  const dayjsLocale = locale === 'en-US' ? 'en'
    : locale === 'zh-TW' ? 'zh-tw'
      : locale === 'ja-JP' ? 'ja'
        : 'zh-cn'
  useEffect(() => {
    dayjs.locale(dayjsLocale)
  }, [dayjsLocale])
  const handleChange = (date: Dayjs | null) => {
    if (!date) return onChange('')
    const adjusted = !date.isAfter(dayjs()) && Math.abs(date.diff(dayjs(), 'second')) <= 2
      ? dayjs().add(1, 'second')
      : date
    onChange(adjusted.format('YYYY-MM-DDTHH:mm:ss'))
  }
  const now = dayjs()
  const presets = [
    { label: t('taskList.scheduledPresetNow'), value: now.add(1, 'second') },
    { label: t('taskList.scheduledPresetTomorrow'), value: now.add(1, 'day') },
    { label: t('taskList.scheduledPresetNextWeek'), value: now.add(1, 'week') },
    { label: t('taskList.scheduledPresetNextMonth'), value: now.add(1, 'month').startOf('month') },
  ]
  return (
    <ConfigProvider locale={antdLocale}>
      <DatePicker
        value={selected}
        onChange={handleChange}
        minDate={minimum || undefined}
        disabledDate={(current) => Boolean(minimum && current.isBefore(minimum, 'day'))}
        showTime={{ format: 'HH:mm:ss', minuteStep: 1, secondStep: 1 }}
        format="YYYY-MM-DD HH:mm:ss"
        locale={antdLocale.DatePicker}
        showNow={false}
        renderExtraFooter={() => (
          <div style={{ display: 'flex', gap: 8, padding: '4px 0', flexWrap: 'wrap' }}>
            {presets.map((preset) => (
              <button
                key={preset.label}
                type="button"
                onClick={() => handleChange(preset.value)}
                style={{ border: 0, padding: '2px 4px', color: 'var(--accent)', background: 'transparent', cursor: 'pointer', fontSize: 12 }}
              >
                {preset.label}
              </button>
            ))}
          </div>
        )}
        allowClear
        disabled={disabled}
        placeholder={t('taskList.scheduledPickerPlaceholder')}
        aria-label={t('taskList.scheduledPickerLabel')}
        style={{ width: '100%' }}
      />
    </ConfigProvider>
  )
}
