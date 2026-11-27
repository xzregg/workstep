import { effectiveSkinTokens, skinColor } from '../skins/contract'
import { useCompactLayout } from '../hooks/useCompactLayout'
import { useActiveSkin } from '../skins/runtime'
import { ConfigProvider, DatePicker, theme } from 'antd'
import zhCN from 'antd/locale/zh_CN.js'
import zhTW from 'antd/locale/zh_TW.js'
import enUS from 'antd/locale/en_US.js'
import jaJP from 'antd/locale/ja_JP.js'
import frFR from 'antd/locale/fr_FR.js'
import deDE from 'antd/locale/de_DE.js'
import ar from 'antd/locale/ar_EG.js'
import dayjs, { type Dayjs } from 'dayjs'
import 'dayjs/locale/zh-cn.js'
import 'dayjs/locale/zh-tw.js'
import 'dayjs/locale/en.js'
import 'dayjs/locale/ja.js'
import 'dayjs/locale/fr.js'
import 'dayjs/locale/de.js'
import 'dayjs/locale/ar.js'
import { useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { useOverlay } from '../hooks/useOverlay'
import Button from './Button'
import './DateTimePicker.css'
import { useI18n } from '../i18n'

interface DateTimePickerProps {
  value: string
  min?: string
  onChange: (value: string) => void
  disabled?: boolean
  precision?: 'minute' | 'second'
  ariaLabel?: string
  popupClassName?: string
}

function parseLocalValue(value: string): Dayjs | null {
  if (!value) return null
  const date = dayjs(value)
  return date.isValid() ? date : null
}

function MobilePickerPanel({ children, open, panelRef }: { children: ReactNode; open: boolean; panelRef: Ref<HTMLDivElement> }) {
  const { t } = useI18n()
  const [viewport, setViewport] = useState({ height: window.innerHeight, top: 0 })
  useEffect(() => {
    if (!open) return
    const visual = window.visualViewport
    const update = () => {
      if (visual && visual.scale !== 1) return
      setViewport({ height: visual?.height ?? window.innerHeight, top: visual?.offsetTop ?? 0 })
    }
    update()
    visual?.addEventListener('resize', update)
    visual?.addEventListener('scroll', update)
    window.addEventListener('resize', update)
    return () => {
      visual?.removeEventListener('resize', update)
      visual?.removeEventListener('scroll', update)
      window.removeEventListener('resize', update)
    }
  }, [open])
  return <div ref={panelRef} className="date-time-picker-mobile-panel" role="dialog" aria-modal="true"
    aria-label={t('taskList.scheduledPickerLabel')}
    style={{ top: viewport.top, maxHeight: viewport.height }}>
    {children}
  </div>
}

export default function DateTimePicker({ value, min, onChange, disabled, precision='second', ariaLabel, popupClassName }: DateTimePickerProps) {
  const [open, setOpen] = useState(false)
  const skin = useActiveSkin()
  const compact = useCompactLayout()
  const panelRef = useRef<HTMLDivElement>(null)
  const [panelMounted, setPanelMounted] = useState(false)
  // Ant Design mounts and caches its popup after the trigger render.
  const attachPanel = useCallback((node: HTMLDivElement | null) => {
    panelRef.current = node
    setPanelMounted(Boolean(node))
  }, [])
  useOverlay(open && compact && panelMounted, () => setOpen(false), panelRef)
  const tokens = effectiveSkinTokens(skin, compact)
  const { t, fallbackLocale: locale } = useI18n()
  const selected = parseLocalValue(value)
  const minimum = parseLocalValue(min || '')
  // Keep Ant Design's calendar, time panel, clear button and “now” action
  // in sync with WorkStep's language setting, not just the outer placeholder.
  const antdLocale = locale === 'en-US' ? enUS
    : locale === 'zh-TW' ? zhTW
      : locale === 'ja-JP' ? jaJP
        : locale === 'fr-FR' ? frFR
          : locale === 'de-DE' ? deDE
            : locale === 'ar' ? ar
              : zhCN
  const dayjsLocale = locale === 'en-US' ? 'en'
    : locale === 'zh-TW' ? 'zh-tw'
      : locale === 'ja-JP' ? 'ja'
        : locale === 'fr-FR' ? 'fr'
          : locale === 'de-DE' ? 'de'
            : locale === 'ar' ? 'ar'
              : 'zh-cn'
  useEffect(() => {
    dayjs.locale(dayjsLocale)
  }, [dayjsLocale])
  const handleChange = (date: Dayjs | null) => {
    if (!date) return onChange('')
    const adjusted = precision === 'minute' ? date.startOf('minute') : !date.isAfter(dayjs()) && Math.abs(date.diff(dayjs(), 'second')) <= 2
      ? dayjs().add(1, 'second')
      : date
    onChange(adjusted.format('YYYY-MM-DDTHH:mm:ss'))
  }
  const now = dayjs()
  const presets = [
    { label: t('taskList.scheduledPresetNow'), value: precision==='minute'?now.add(1,'minute').startOf('minute'):now.add(1, 'second') },
    { label: t('taskList.scheduledPresetTomorrow'), value: now.add(1, 'day') },
    { label: t('taskList.scheduledPresetNextWeek'), value: now.add(1, 'week') },
    { label: t('taskList.scheduledPresetNextMonth'), value: now.add(1, 'month').startOf('month') },
  ]
  return (
    <ConfigProvider locale={antdLocale} theme={skin.manifest.id === 'default' ? undefined : {
      algorithm: skin.manifest.color_scheme === 'dark' ? theme.darkAlgorithm : theme.defaultAlgorithm,
      token: { colorPrimary: skinColor(tokens, 'accent'), colorBgContainer: skinColor(tokens, 'bg'),
        colorText: skinColor(tokens, 'fg'), colorBorder: skinColor(tokens, 'border') },
    }}>
      <DatePicker
        value={selected}
        open={open}
        onOpenChange={setOpen}
        inputReadOnly={compact}
        panelRender={compact ? panel => <MobilePickerPanel panelRef={attachPanel} open={open}>{panel}</MobilePickerPanel> : undefined}
        onChange={handleChange}
        minDate={minimum || undefined}
        disabledDate={(current) => Boolean(minimum && current.isBefore(minimum, 'day'))}
        showTime={{ format: precision==='minute'?'HH:mm':'HH:mm:ss', minuteStep: 1, secondStep: 1 }}
        format={precision==='minute'?'YYYY-MM-DD HH:mm':'YYYY-MM-DD HH:mm:ss'}
        locale={antdLocale.DatePicker}
        showNow={false}
        renderExtraFooter={() => (
          <>
            <div className="date-time-picker-presets">
              {presets.map((preset) => (
                <button
                  key={preset.label}
                  type="button"
                  onClick={() => handleChange(preset.value)}
                  className="date-time-picker-preset"
                >
                  {preset.label}
                </button>
              ))}
            </div>
            {compact && <Button type="button" variant="ghost" className="date-time-picker-cancel" onClick={() => setOpen(false)}>{t('common.cancel')}</Button>}
          </>
        )}
        allowClear
        disabled={disabled}
        placeholder={t('taskList.scheduledPickerPlaceholder')}
        aria-label={ariaLabel??t('taskList.scheduledPickerLabel')}
        classNames={{ popup: { root: ['workstep-date-popup', popupClassName].filter(Boolean).join(' ') } }}
        className="date-time-picker"
      />
    </ConfigProvider>
  )
}
