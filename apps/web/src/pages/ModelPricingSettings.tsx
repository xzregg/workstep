import { useEffect, useMemo, useState } from 'react'
import Button from '../components/Button'
import Input from '../components/Input'
import Select from '../components/Select'
import {
  systemSettingsApi,
  type ModelPrice,
  type ModelPricingSettings,
} from '../api/client'
import { useI18n } from '../i18n'

interface CatalogModel {
  providerId: string | null
  group: string
  model: string
}

const priceKey = (providerId: string | null, model: string) => `${providerId || ''}\u0000${model}`
const emptyPrice = (providerId: string | null, model: string): ModelPrice => ({
  provider_id: providerId,
  model,
  input_price: 0,
  output_price: 0,
  cache_price: 0,
})

export default function ModelPricingSettingsPage() {
  const { t } = useI18n()
  const [settings, setSettings] = useState<ModelPricingSettings>({
    currency: 'USD',
    usd_to_cny_rate: 7.2,
    prices: [],
    providers: [],
    standalone_models: [],
  })
  const [catalog, setCatalog] = useState<CatalogModel[]>([])
  const [enabledProviderIds, setEnabledProviderIds] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const [filterQuery, setFilterQuery] = useState('')
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set())
  const [bulkPrices, setBulkPrices] = useState({
    input_price: '0',
    output_price: '0',
    cache_price: '0',
  })

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setLoading(true)
      setError('')
      try {
        const pricing = await systemSettingsApi.modelPricing()
        const providerRows = pricing.providers.flatMap((provider) =>
          provider.models.map((model) => ({
            providerId: provider.id,
            group: provider.name,
            model: model.id,
          })),
        )
        const standaloneRows = pricing.standalone_models.map((model) => ({
          providerId: null,
          group: t('settings.pricingStandalone'),
          model,
        }))
        if (cancelled) return
        setSettings(pricing)
        setEnabledProviderIds(new Set(pricing.providers.map((provider) => provider.id)))
        setCatalog([
          ...providerRows,
          ...standaloneRows,
        ])
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => { cancelled = true }
  }, [t])

  const rows = useMemo(() => {
    const byKey = new Map<string, CatalogModel>()
    for (const item of catalog) byKey.set(priceKey(item.providerId, item.model), item)
    for (const item of settings.prices) {
      if (item.provider_id && !enabledProviderIds.has(item.provider_id)) continue
      const key = priceKey(item.provider_id, item.model)
      if (!byKey.has(key)) {
        byKey.set(key, {
          providerId: item.provider_id,
          group: item.provider_id || t('settings.pricingStandalone'),
          model: item.model,
        })
      }
    }
    return Array.from(byKey.values()).sort((a, b) =>
      a.group.localeCompare(b.group) || a.model.localeCompare(b.model)
    )
  }, [catalog, enabledProviderIds, settings.prices, t])

  const prices = useMemo(
    () => new Map(settings.prices.map((item) => [priceKey(item.provider_id, item.model), item])),
    [settings.prices],
  )

  const filteredRows = useMemo(() => {
    const query = filterQuery.trim().toLocaleLowerCase()
    if (!query) return rows
    return rows.filter((row) =>
      row.group.toLocaleLowerCase().includes(query)
      || row.model.toLocaleLowerCase().includes(query)
    )
  }, [filterQuery, rows])

  const updatePrice = (row: CatalogModel, field: keyof Pick<ModelPrice, 'input_price' | 'output_price' | 'cache_price'>, value: string) => {
    const number = Math.max(0, Number(value) || 0)
    const key = priceKey(row.providerId, row.model)
    const next = new Map(prices)
    next.set(key, { ...(next.get(key) || emptyPrice(row.providerId, row.model)), [field]: number })
    setSettings((current) => ({ ...current, prices: Array.from(next.values()) }))
    setSaved(false)
  }

  const applyBulkPrices = () => {
    const next = new Map(prices)
    for (const row of rows) {
      const key = priceKey(row.providerId, row.model)
      if (!selectedKeys.has(key)) continue
      next.set(key, {
        provider_id: row.providerId,
        model: row.model,
        input_price: Math.max(0, Number(bulkPrices.input_price) || 0),
        output_price: Math.max(0, Number(bulkPrices.output_price) || 0),
        cache_price: Math.max(0, Number(bulkPrices.cache_price) || 0),
      })
    }
    setSettings((current) => ({ ...current, prices: Array.from(next.values()) }))
    setSaved(false)
  }

  const changeCurrency = (currency: 'USD' | 'CNY') => {
    if (currency === settings.currency) return
    const factor = currency === 'CNY' ? settings.usd_to_cny_rate : 1 / settings.usd_to_cny_rate
    setSettings((current) => ({
      ...current,
      currency,
      prices: current.prices.map((item) => ({
        ...item,
        input_price: Number((item.input_price * factor).toFixed(6)),
        output_price: Number((item.output_price * factor).toFixed(6)),
        cache_price: Number((item.cache_price * factor).toFixed(6)),
      })),
    }))
    setSaved(false)
  }

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      const { providers: _providers, standalone_models: _standaloneModels, ...config } = settings
      const result = await systemSettingsApi.saveModelPricing({
        ...config,
        prices: settings.prices.filter((item) =>
          (!item.provider_id || enabledProviderIds.has(item.provider_id))
          && (item.input_price > 0 || item.output_price > 0 || item.cache_price > 0)
        ),
      })
      setSettings(result)
      setSaved(true)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ maxWidth: 960, margin: '0 auto' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginBottom: 18 }}>
        <div style={{ flex: 1 }}>
          <h1 style={{ fontSize: 20, fontWeight: 650, marginBottom: 6 }}>{t('settings.pricingTitle')}</h1>
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>{t('settings.pricingIntro')}</p>
        </div>
        <Button variant="primary" onClick={() => void save()} disabled={loading || saving} loading={saving}>
          {t('common.save')}
        </Button>
      </div>

      <div style={{ display: 'flex', gap: 14, alignItems: 'end', padding: 14, marginBottom: 14, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg)' }}>
        <label style={{ fontSize: 12, color: 'var(--muted)' }}>
          {t('settings.pricingCurrency')}
          <Select value={settings.currency} onChange={(event) => changeCurrency(event.target.value as 'USD' | 'CNY')} style={{ display: 'block', width: 130, marginTop: 6 }}>
            <option value="USD">USD ($)</option>
            <option value="CNY">CNY (¥)</option>
          </Select>
        </label>
        <label style={{ fontSize: 12, color: 'var(--muted)' }}>
          {t('settings.pricingRate')}
          <Input type="number" min="0.000001" step="0.01" value={settings.usd_to_cny_rate} onChange={(event) => {
            setSettings((current) => ({ ...current, usd_to_cny_rate: Math.max(0.000001, Number(event.target.value) || 0.000001) }))
            setSaved(false)
          }} style={{ display: 'block', width: 150, marginTop: 6 }} />
        </label>
        <span style={{ color: 'var(--meta)', fontSize: 11, paddingBottom: 9 }}>{t('settings.pricingUnit', { currency: settings.currency })}</span>
      </div>

      {error && <div role="alert" style={{ color: 'var(--danger)', fontSize: 12, marginBottom: 10 }}>{error}</div>}
      {saved && <div role="status" style={{ color: 'var(--success)', fontSize: 12, marginBottom: 10 }}>{t('settings.pricingSaved')}</div>}
      {loading ? (
        <div style={{ padding: 28, textAlign: 'center', color: 'var(--meta)' }}>{t('common.loading')}</div>
      ) : rows.length === 0 ? (
        <div style={{ padding: 28, textAlign: 'center', color: 'var(--meta)', border: '1px solid var(--border)', borderRadius: 10 }}>{t('settings.pricingEmpty')}</div>
      ) : (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            <Input
              type="search"
              value={filterQuery}
              onChange={(event) => setFilterQuery(event.target.value)}
              placeholder={t('settings.pricingFilterPlaceholder')}
              aria-label={t('settings.pricingFilterPlaceholder')}
              style={{ width: 'min(360px, 100%)' }}
            />
            <span style={{ color: 'var(--meta)', fontSize: 11 }}>
              {t('settings.pricingFilterCount', { count: filteredRows.length })}
            </span>
          </div>
          <div style={{
            display: 'flex', alignItems: 'end', gap: 10, flexWrap: 'wrap',
            padding: 12, marginBottom: 10, border: '1px solid var(--border)',
            borderRadius: 10, background: 'var(--surface)',
          }}>
            {(['input_price', 'output_price', 'cache_price'] as const).map((field) => (
              <label key={field} style={{ fontSize: 11, color: 'var(--muted)' }}>
                {t(field === 'input_price' ? 'settings.pricingInput' : field === 'output_price' ? 'settings.pricingOutput' : 'settings.pricingCache')}
                <Input
                  type="number"
                  min="0"
                  step="0.000001"
                  value={bulkPrices[field]}
                  onChange={(event) => setBulkPrices((current) => ({ ...current, [field]: event.target.value }))}
                  style={{ display: 'block', width: 120, marginTop: 5, textAlign: 'right' }}
                />
              </label>
            ))}
            <Button
              variant="ghost"
              disabled={selectedKeys.size === 0}
              onClick={applyBulkPrices}
              style={{ height: 34 }}
            >
              {t('settings.pricingBatchApply', { count: selectedKeys.size })}
            </Button>
          </div>
          <div className="statistics-table-wrap" style={{ border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg)' }}>
          <table className="statistics-table">
            <thead><tr>
              <th style={{ width: 40 }}>
                <input
                  type="checkbox"
                  aria-label={t('settings.pricingSelectAll')}
                      checked={filteredRows.length > 0 && filteredRows.every((row) => selectedKeys.has(priceKey(row.providerId, row.model)))}
                      onChange={(event) => setSelectedKeys(event.target.checked
                        ? new Set(filteredRows.map((row) => priceKey(row.providerId, row.model)))
                        : new Set())}
                />
              </th>
              <th>{t('settings.pricingProvider')}</th>
              <th>{t('statistics.model')}</th>
              <th>{t('settings.pricingInput')}</th>
              <th>{t('settings.pricingOutput')}</th>
              <th>{t('settings.pricingCache')}</th>
            </tr></thead>
                <tbody>{filteredRows.length === 0 ? (
                  <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--meta)', padding: 24 }}>{t('settings.pricingFilterEmpty')}</td></tr>
                ) : filteredRows.map((row) => {
              const price = prices.get(priceKey(row.providerId, row.model)) || emptyPrice(row.providerId, row.model)
              return (
                <tr key={priceKey(row.providerId, row.model)}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`${row.group} ${row.model}`}
                      checked={selectedKeys.has(priceKey(row.providerId, row.model))}
                      onChange={(event) => setSelectedKeys((current) => {
                        const next = new Set(current)
                        const key = priceKey(row.providerId, row.model)
                        if (event.target.checked) next.add(key)
                        else next.delete(key)
                        return next
                      })}
                    />
                  </td>
                  <td>{row.group}</td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{row.model}</td>
                  {(['input_price', 'output_price', 'cache_price'] as const).map((field) => (
                    <td key={field}><Input type="number" min="0" step="0.000001" value={price[field]} onChange={(event) => updatePrice(row, field, event.target.value)} style={{ width: 120, textAlign: 'right' }} /></td>
                  ))}
                </tr>
              )
                })}</tbody>
          </table>
          </div>
        </div>
      )}
    </div>
  )
}
