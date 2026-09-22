import { useEffect, useMemo, useState } from 'react'
import Button from '../components/Button'
import Input from '../components/Input'
import Select from '../components/Select'
import {
  systemSettingsApi,
  type ModelSetting,
  type ModelSettings,
  type ModelType,
} from '../api/client'
import { useI18n } from '../i18n'
import { engineLabel } from '../engineMeta'

interface CatalogModel {
  sourceType: 'provider' | 'engine' | 'custom'
  sourceId: string | null
  group: string
  model: string
}

const priceKey = (row: Pick<CatalogModel, 'sourceType' | 'sourceId' | 'model'>) =>
  `${row.sourceType}\u0000${row.sourceId || ''}\u0000${row.model}`

const priceKeyFromSetting = (item: ModelSetting) => priceKey({
  sourceType: item.provider_id ? 'provider' : item.engine_id ? 'engine' : 'custom',
  sourceId: item.provider_id || item.engine_id,
  model: item.model,
})

const emptyPrice = (row: CatalogModel): ModelSetting => ({
  provider_id: row.sourceType === 'provider' ? row.sourceId : null,
  engine_id: row.sourceType === 'engine' ? row.sourceId : null,
  model: row.model,
  model_type: 'chat',
  supports_multimodal: false,
  input_price: 0,
  output_price: 0,
  cache_price: 0,
})

const MODEL_TYPES: Array<{ value: ModelType; label: 'settings.pricingTypeChat' | 'settings.pricingTypeReasoning' | 'settings.pricingTypeEmbedding' | 'settings.pricingTypeRerank' | 'settings.pricingTypeImage' | 'settings.pricingTypeAudio' }> = [
  { value: 'chat', label: 'settings.pricingTypeChat' },
  { value: 'reasoning', label: 'settings.pricingTypeReasoning' },
  { value: 'embedding', label: 'settings.pricingTypeEmbedding' },
  { value: 'rerank', label: 'settings.pricingTypeRerank' },
  { value: 'image', label: 'settings.pricingTypeImage' },
  { value: 'audio', label: 'settings.pricingTypeAudio' },
]

export default function ModelSettingsPage() {
  const { t } = useI18n()
  const [settings, setSettings] = useState<ModelSettings>({
    currency: 'USD',
    usd_to_cny_rate: 7.2,
    prices: [],
    providers: [],
    engines: [],
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
        const pricing = await systemSettingsApi.modelSettings()
        const providerRows = pricing.providers.flatMap((provider) =>
          provider.models.map((model) => ({
            sourceType: 'provider' as const,
            sourceId: provider.id,
            group: provider.name,
            model: model.id,
          })),
        )
        const engineRows = pricing.engines.flatMap((engine) =>
          engine.models.map((model) => ({
            sourceType: 'engine' as const,
            sourceId: engine.id,
            group: engine.id,
            model: model.id,
          })),
        )
        if (cancelled) return
        setSettings(pricing)
        setEnabledProviderIds(new Set(pricing.providers.map((provider) => provider.id)))
        setCatalog([
          ...providerRows,
          ...engineRows,
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
    for (const item of catalog) byKey.set(priceKey(item), item)
    for (const item of settings.prices) {
      if (item.provider_id && !enabledProviderIds.has(item.provider_id)) continue
      const key = priceKeyFromSetting(item)
      if (!byKey.has(key)) {
        byKey.set(key, {
          sourceType: item.provider_id ? 'provider' : item.engine_id ? 'engine' : 'custom',
          sourceId: item.provider_id || item.engine_id,
          group: item.provider_id || item.engine_id || t('settings.pricingStandalone'),
          model: item.model,
        })
      }
    }
    return Array.from(byKey.values()).sort((a, b) =>
      a.group.localeCompare(b.group) || a.model.localeCompare(b.model)
    )
  }, [catalog, enabledProviderIds, settings.prices, t])

  const prices = useMemo(
    () => new Map(settings.prices.map((item) => [priceKeyFromSetting(item), item])),
    [settings.prices],
  )

  const filteredRows = useMemo(() => {
    const query = filterQuery.trim().toLocaleLowerCase()
    if (!query) return rows
    return rows.filter((row) =>
      row.group.toLocaleLowerCase().includes(query)
      || (row.sourceType === 'engine' && engineLabel(row.sourceId || '', t).toLocaleLowerCase().includes(query))
      || row.model.toLocaleLowerCase().includes(query)
    )
  }, [filterQuery, rows, t])

  const updatePrice = (row: CatalogModel, field: keyof Pick<ModelSetting, 'input_price' | 'output_price' | 'cache_price'>, value: string) => {
    const number = Math.max(0, Number(value) || 0)
    const key = priceKey(row)
    const next = new Map(prices)
    next.set(key, { ...(next.get(key) || emptyPrice(row)), [field]: number })
    setSettings((current) => ({ ...current, prices: Array.from(next.values()) }))
    setSaved(false)
  }

  const updateMetadata = (
    row: CatalogModel,
    patch: Pick<Partial<ModelSetting>, 'model_type' | 'supports_multimodal'>,
  ) => {
    const key = priceKey(row)
    const next = new Map(prices)
    next.set(key, { ...(next.get(key) || emptyPrice(row)), ...patch })
    setSettings((current) => ({ ...current, prices: Array.from(next.values()) }))
    setSaved(false)
  }

  const applyBulkPrices = () => {
    const next = new Map(prices)
    for (const row of rows) {
      const key = priceKey(row)
      if (!selectedKeys.has(key)) continue
      next.set(key, {
        ...(next.get(key) || emptyPrice(row)),
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
      const { providers: _providers, engines: _engines, standalone_models: _standaloneModels, ...config } = settings
      const result = await systemSettingsApi.saveModelSettings({
        ...config,
        prices: settings.prices.filter((item) =>
          (!item.provider_id || enabledProviderIds.has(item.provider_id))
          && (
            item.input_price > 0 || item.output_price > 0 || item.cache_price > 0
            || item.model_type !== 'chat' || item.supports_multimodal
          )
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
          <h1 style={{ fontSize: 'calc(20px * var(--font-scale))', fontWeight: 650, marginBottom: 6 }}>{t('settings.pricingTitle')}</h1>
          <p style={{ color: 'var(--muted)', fontSize: 'calc(13px * var(--font-scale))' }}>{t('settings.pricingIntro')}</p>
        </div>
        <Button variant="primary" onClick={() => void save()} disabled={loading || saving} loading={saving}>
          {t('common.save')}
        </Button>
      </div>

      <div style={{ display: 'flex', gap: 14, alignItems: 'end', padding: 14, marginBottom: 14, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg)' }}>
        <label style={{ fontSize: 'calc(12px * var(--font-scale))', color: 'var(--muted)' }}>
          {t('settings.pricingCurrency')}
          <Select value={settings.currency} onChange={(event) => changeCurrency(event.target.value as 'USD' | 'CNY')} style={{ display: 'block', width: 130, marginTop: 6 }}>
            <option value="USD">USD ($)</option>
            <option value="CNY">CNY (¥)</option>
          </Select>
        </label>
        <label style={{ fontSize: 'calc(12px * var(--font-scale))', color: 'var(--muted)' }}>
          {t('settings.pricingRate')}
          <Input type="number" min="0.000001" step="0.01" value={settings.usd_to_cny_rate} onChange={(event) => {
            setSettings((current) => ({ ...current, usd_to_cny_rate: Math.max(0.000001, Number(event.target.value) || 0.000001) }))
            setSaved(false)
          }} style={{ display: 'block', width: 150, marginTop: 6 }} />
        </label>
        <span style={{ color: 'var(--meta)', fontSize: 'calc(11px * var(--font-scale))', paddingBottom: 9 }}>{t('settings.pricingUnit', { currency: settings.currency })}</span>
      </div>

      {error && <div role="alert" style={{ color: 'var(--danger)', fontSize: 'calc(12px * var(--font-scale))', marginBottom: 10 }}>{error}</div>}
      {saved && <div role="status" style={{ color: 'var(--success)', fontSize: 'calc(12px * var(--font-scale))', marginBottom: 10 }}>{t('settings.pricingSaved')}</div>}
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
            <span style={{ color: 'var(--meta)', fontSize: 'calc(11px * var(--font-scale))' }}>
              {t('settings.pricingFilterCount', { count: filteredRows.length })}
            </span>
          </div>
          <div style={{
            display: 'flex', alignItems: 'end', gap: 10, flexWrap: 'wrap',
            padding: 12, marginBottom: 10, border: '1px solid var(--border)',
            borderRadius: 10, background: 'var(--surface)',
          }}>
            {(['input_price', 'output_price', 'cache_price'] as const).map((field) => (
              <label key={field} style={{ fontSize: 'calc(11px * var(--font-scale))', color: 'var(--muted)' }}>
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
                      checked={filteredRows.length > 0 && filteredRows.every((row) => selectedKeys.has(priceKey(row)))}
                      onChange={(event) => setSelectedKeys(event.target.checked
                        ? new Set(filteredRows.map((row) => priceKey(row)))
                        : new Set())}
                />
              </th>
              <th style={{ textAlign: 'left' }}>{t('settings.pricingSource')}</th>
              <th style={{ textAlign: 'left' }}>{t('statistics.model')}</th>
              <th style={{ textAlign: 'left' }}>{t('settings.pricingModelType')}</th>
              <th>{t('settings.pricingMultimodal')}</th>
              <th>{t('settings.pricingInput')}</th>
              <th>{t('settings.pricingOutput')}</th>
              <th>{t('settings.pricingCache')}</th>
            </tr></thead>
                <tbody>{filteredRows.length === 0 ? (
                  <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--meta)', padding: 24 }}>{t('settings.pricingFilterEmpty')}</td></tr>
                ) : filteredRows.map((row) => {
              const price = prices.get(priceKey(row)) || emptyPrice(row)
              const sourceName = row.sourceType === 'engine' && row.sourceId
                ? engineLabel(row.sourceId, t)
                : row.group
              return (
                <tr key={priceKey(row)}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`${sourceName} ${row.model}`}
                      checked={selectedKeys.has(priceKey(row))}
                      onChange={(event) => setSelectedKeys((current) => {
                        const next = new Set(current)
                        const key = priceKey(row)
                        if (event.target.checked) next.add(key)
                        else next.delete(key)
                        return next
                      })}
                    />
                  </td>
                  <td style={{ textAlign: 'left' }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
                      <span style={{ padding: '2px 7px', borderRadius: 999, background: 'var(--surface)', color: 'var(--meta)', fontSize: 'calc(10px * var(--font-scale))' }}>
                        {t(row.sourceType === 'provider' ? 'settings.pricingSourceProvider' : row.sourceType === 'engine' ? 'settings.pricingSourceEngine' : 'settings.pricingSourceCustom')}
                      </span>
                      <span>{sourceName}</span>
                    </span>
                  </td>
                  <td style={{ textAlign: 'left', fontFamily: 'var(--font-mono)', fontSize: 'calc(11px * var(--font-scale))' }}>{row.model}</td>
                  <td style={{ textAlign: 'left' }}>
                    <Select
                      value={price.model_type}
                      aria-label={`${row.model} ${t('settings.pricingModelType')}`}
                      onChange={(event) => updateMetadata(row, { model_type: event.target.value as ModelType })}
                      style={{ width: 112 }}
                    >
                      {MODEL_TYPES.map((type) => <option key={type.value} value={type.value}>{t(type.label)}</option>)}
                    </Select>
                  </td>
                  <td>
                    <button
                      type="button"
                      className="settings-switch"
                      role="switch"
                      aria-checked={price.supports_multimodal}
                      aria-label={`${row.model} ${t('settings.pricingMultimodal')}`}
                      onClick={() => updateMetadata(row, { supports_multimodal: !price.supports_multimodal })}
                      style={{ background: price.supports_multimodal ? 'var(--accent)' : 'var(--border)' }}
                    >
                      <span className="settings-switch-thumb" />
                    </button>
                  </td>
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
