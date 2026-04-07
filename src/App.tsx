import { useMemo, useState, type FormEvent } from 'react'
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import './App.css'

type MediaMode = 'books' | 'newspapers'
type TemporalGranularity = 'year' | 'month' | 'day'

type TrendPoint = {
  bucket: string
  sortValue: number
  count: number
  totalCount: number
  relativePercent: number
}

type TrendSeries = {
  phrase: string
  points: TrendPoint[]
  totalHits: number
}

type YearBucket = {
  year: number
  count: number
}

const SEARCH_API_BASE_URL = 'https://api.nb.no/catalog/v1/search'
const ITEMS_API_BASE_URL = 'https://api.nb.no/catalog/v1/items'
const AGG_SIZE = '1000'
const ITEMS_PAGE_SIZE = 100
const MAX_PAGES_PER_YEAR = 20
const MIN_YEAR = 1000
const MAX_YEAR = new Date().getFullYear()
const COLOR_PALETTE = ['#005aa7', '#d9480f', '#2b8a3e', '#5f3dc4', '#0b7285']
const MODE_CONFIG: Record<
  MediaMode,
  { mediatypeFilter: string; resultNoun: string }
> = {
  books: { mediatypeFilter: 'bøker', resultNoun: 'bøker' },
  newspapers: { mediatypeFilter: 'aviser', resultNoun: 'aviser' },
}

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message
  }
  return 'Ukjent feil ved henting av data.'
}

const parsePhrases = (input: string): string[] =>
  Array.from(
    new Set(
      input
        .split(/\n|,/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  )

const toYearBucketPoint = (
  bucket: YearBucket,
  totalsByYear?: Map<number, number>,
): TrendPoint => {
  const totalCount = totalsByYear?.get(bucket.year) ?? 0
  const relativePercent =
    totalsByYear && totalCount > 0 ? (bucket.count / totalCount) * 100 : 0

  return {
    bucket: String(bucket.year),
    sortValue: bucket.year,
    count: bucket.count,
    totalCount,
    relativePercent,
  }
}

const fetchYearBuckets = async (
  query: string,
  mode: MediaMode,
  digitalAccessibleOnly: boolean,
): Promise<YearBucket[]> => {
  const params = new URLSearchParams({
    q: query,
    filter: `mediatype:${MODE_CONFIG[mode].mediatypeFilter}`,
    aggs: `year:${AGG_SIZE}:termasc`,
    searchType: 'FULL_TEXT_SEARCH',
  })

  if (digitalAccessibleOnly) {
    params.set('digitalAccessibleOnly', 'true')
  }

  const response = await fetch(`${SEARCH_API_BASE_URL}?${params.toString()}`)
  if (!response.ok) {
    throw new Error(`NB API feilet med status ${response.status}`)
  }

  const data = (await response.json()) as {
    _embedded?: {
      aggregations?: Array<{
        name?: string
        buckets?: Array<{ key?: string; count?: number }>
      }>
    }
  }

  const yearAggregation = data._embedded?.aggregations?.find(
    (aggregation) => aggregation.name === 'year',
  )

  return (
    yearAggregation?.buckets
      ?.map((bucket) => {
        const year = Number(bucket.key)
        const count = Number(bucket.count)
        if (!Number.isFinite(year) || !Number.isFinite(count)) {
          return null
        }
        return { year, count }
      })
      .filter(
        (point): point is YearBucket =>
          point !== null && point.year >= MIN_YEAR && point.year <= MAX_YEAR,
      ) ?? []
  )
}

const bucketFromIssued = (
  issued: string,
  granularity: TemporalGranularity,
): { bucket: string; sortValue: number } | null => {
  if (!/^\d{8}$/.test(issued)) {
    return null
  }

  const year = Number(issued.slice(0, 4))
  const month = Number(issued.slice(4, 6))
  const day = Number(issued.slice(6, 8))
  if (
    !Number.isFinite(year) ||
    !Number.isFinite(month) ||
    !Number.isFinite(day)
  ) {
    return null
  }

  if (granularity === 'month') {
    const bucket = `${issued.slice(0, 4)}-${issued.slice(4, 6)}`
    return { bucket, sortValue: year * 100 + month }
  }

  const bucket = `${issued.slice(0, 4)}-${issued.slice(4, 6)}-${issued.slice(6, 8)}`
  return { bucket, sortValue: year * 10000 + month * 100 + day }
}

const fetchIssuedBuckets = async (
  query: string,
  mode: MediaMode,
  digitalAccessibleOnly: boolean,
  fromYear: number,
  toYear: number,
  granularity: 'month' | 'day',
): Promise<TrendPoint[]> => {
  const counts = new Map<string, { sortValue: number; count: number }>()

  for (let year = fromYear; year <= toYear; year += 1) {
    for (let page = 0; page < MAX_PAGES_PER_YEAR; page += 1) {
      const params = new URLSearchParams({
        q: query,
        filter: `mediatype:${MODE_CONFIG[mode].mediatypeFilter}`,
        searchType: 'FULL_TEXT_SEARCH',
        size: String(ITEMS_PAGE_SIZE),
        page: String(page),
      })
      params.append('filter', `year:${year}`)

      if (digitalAccessibleOnly) {
        params.set('digitalAccessibleOnly', 'true')
      }

      const response = await fetch(`${ITEMS_API_BASE_URL}?${params.toString()}`)
      if (!response.ok) {
        throw new Error(`NB items-API feilet med status ${response.status}`)
      }

      const data = (await response.json()) as {
        page?: { totalPages?: number }
        _embedded?: {
          items?: Array<{
            metadata?: { originInfo?: { issued?: string } }
          }>
        }
      }

      const items = data._embedded?.items ?? []
      for (const item of items) {
        const issued = item.metadata?.originInfo?.issued
        if (!issued) {
          continue
        }

        const bucket = bucketFromIssued(issued, granularity)
        if (!bucket) {
          continue
        }

        const previous = counts.get(bucket.bucket)
        counts.set(bucket.bucket, {
          sortValue: bucket.sortValue,
          count: (previous?.count ?? 0) + 1,
        })
      }

      const totalPages = data.page?.totalPages ?? 0
      if (page + 1 >= totalPages) {
        break
      }
    }
  }

  return Array.from(counts.entries())
    .map(([bucket, value]) => ({
      bucket,
      sortValue: value.sortValue,
      count: value.count,
      totalCount: 0,
      relativePercent: 0,
    }))
    .sort((a, b) => a.sortValue - b.sortValue)
}

function App() {
  const [mode, setMode] = useState<MediaMode>('books')
  const [granularity, setGranularity] = useState<TemporalGranularity>('year')
  const [detailPeriodYears, setDetailPeriodYears] = useState<5 | 10>(5)
  const [queryInput, setQueryInput] = useState('hamsun')
  const [digitalAccessibleOnly, setDigitalAccessibleOnly] = useState(false)
  const [loading, setLoading] = useState(false)
  const [relativeMode, setRelativeMode] = useState(true)
  const [fromYear, setFromYear] = useState(1800)
  const [toYear, setToYear] = useState(MAX_YEAR)
  const [strokeWidth, setStrokeWidth] = useState(2)
  const [error, setError] = useState<string | null>(null)
  const [series, setSeries] = useState<TrendSeries[]>([])
  const modeMeta = MODE_CONFIG[mode]

  const detailMode = mode === 'newspapers' && granularity !== 'year'
  const selectedToYear = Math.min(MAX_YEAR, Math.max(fromYear, toYear))
  const selectedFromYear = detailMode
    ? selectedToYear - detailPeriodYears + 1
    : Math.max(MIN_YEAR, Math.min(fromYear, toYear))

  const filteredSeries = useMemo(() => {
    if (detailMode) {
      return series
    }

    return series.map((trendSeries) => ({
      ...trendSeries,
      points: trendSeries.points.filter((point) => {
        const year = Number(point.bucket.slice(0, 4))
        return year >= selectedFromYear && year <= selectedToYear
      }),
    }))
  }, [detailMode, selectedFromYear, selectedToYear, series])

  const chartSeriesConfig = useMemo(
    () =>
      filteredSeries.map((trendSeries, index) => ({
        dataKey: `series_${index}`,
        phrase: trendSeries.phrase,
        color: COLOR_PALETTE[index % COLOR_PALETTE.length],
      })),
    [filteredSeries],
  )

  const chartData = useMemo(() => {
    const bucketIndex = new Map<
      string,
      { bucket: string; sortValue: number; values: Record<string, number | null> }
    >()

    filteredSeries.forEach((trendSeries, index) => {
      const dataKey = `series_${index}`
      trendSeries.points.forEach((point) => {
        const row =
          bucketIndex.get(point.bucket) ??
          { bucket: point.bucket, sortValue: point.sortValue, values: {} }

        row.values[dataKey] =
          relativeMode && !detailMode ? point.relativePercent : point.count
        bucketIndex.set(point.bucket, row)
      })
    })

    return Array.from(bucketIndex.values())
      .sort((a, b) => a.sortValue - b.sortValue)
      .map((row) => ({ bucket: row.bucket, ...row.values }))
  }, [detailMode, filteredSeries, relativeMode])

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()

    const phrases = parsePhrases(queryInput)
    if (phrases.length === 0) {
      setError('Skriv inn minst én frase før du søker.')
      return
    }

    setLoading(true)
    setError(null)

    try {
      if (detailMode) {
        const detailSeries = await Promise.all(
          phrases.map(async (phrase) => {
            const points = await fetchIssuedBuckets(
              phrase,
              mode,
              digitalAccessibleOnly,
              selectedFromYear,
              selectedToYear,
              granularity,
            )

            return {
              phrase,
              points,
              totalHits: points.reduce((sum, point) => sum + point.count, 0),
            }
          }),
        )
        setSeries(detailSeries)
      } else {
        const totalBuckets = await fetchYearBuckets('', mode, digitalAccessibleOnly)
        const totalsByYear = new Map<number, number>(
          totalBuckets.map((bucket) => [bucket.year, bucket.count]),
        )

        const trendSeries = await Promise.all(
          phrases.map(async (phrase) => {
            const queryBuckets = await fetchYearBuckets(
              phrase,
              mode,
              digitalAccessibleOnly,
            )
            const points = queryBuckets.map((bucket) =>
              toYearBucketPoint(bucket, totalsByYear),
            )
            return {
              phrase,
              points,
              totalHits: points.reduce((sum, point) => sum + point.count, 0),
            }
          }),
        )
        setSeries(trendSeries)
      }
    } catch (requestError) {
      setError(getErrorMessage(requestError))
      setSeries([])
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="container">
      <header>
        <h1>Trendlinjer for OsloMet</h1>
        <p>
          Sjekk hvor mange {modeMeta.resultNoun} som matcher en frase i NB.
        </p>
      </header>

      <form className="search-form" onSubmit={handleSubmit}>
        <div className="mode-switch" role="group" aria-label="Materialtype">
          <button
            type="button"
            className={mode === 'books' ? 'mode-button active' : 'mode-button'}
            onClick={() => {
              setMode('books')
              setGranularity('year')
            }}
          >
            Bøker
          </button>
          <button
            type="button"
            className={mode === 'newspapers' ? 'mode-button active' : 'mode-button'}
            onClick={() => setMode('newspapers')}
          >
            Aviser
          </button>
        </div>

        <label htmlFor="granularity">
          Tidsoppløsning
          <select
            id="granularity"
            value={granularity}
            onChange={(event) =>
              setGranularity(event.target.value as TemporalGranularity)
            }
          >
            <option value="year">År</option>
            <option value="month" disabled={mode !== 'newspapers'}>
              Måned
            </option>
            <option value="day" disabled={mode !== 'newspapers'}>
              Dag
            </option>
          </select>
        </label>

        <label htmlFor="query">Fraser (én per linje eller komma-separert)</label>
        <textarea
          id="query"
          value={queryInput}
          onChange={(event) => setQueryInput(event.target.value)}
          placeholder="f.eks. hamsun&#10;og&#10;i natt"
          rows={4}
        />

        <div className="controls-grid">
          <label htmlFor="fromYear">
            Fra år
            <input
              id="fromYear"
              type="number"
              min={MIN_YEAR}
              max={MAX_YEAR}
              value={selectedFromYear}
              onChange={(event) => setFromYear(Number(event.target.value))}
              disabled={detailMode}
            />
          </label>
          <label htmlFor="toYear">
            Til år
            <input
              id="toYear"
              type="number"
              min={MIN_YEAR}
              max={MAX_YEAR}
              value={selectedToYear}
              onChange={(event) => setToYear(Number(event.target.value))}
            />
          </label>
        </div>

        {detailMode ? (
          <label htmlFor="detailPeriodYears">
            Detaljperiode
            <select
              id="detailPeriodYears"
              value={detailPeriodYears}
              onChange={(event) =>
                setDetailPeriodYears(Number(event.target.value) as 5 | 10)
              }
            >
              <option value={5}>5 år</option>
              <option value={10}>10 år</option>
            </select>
          </label>
        ) : null}

        <label htmlFor="strokeWidth">
          Linjetykkelse: {strokeWidth}
          <input
            id="strokeWidth"
            type="range"
            min={1}
            max={8}
            step={1}
            value={strokeWidth}
            onChange={(event) => setStrokeWidth(Number(event.target.value))}
          />
        </label>

        <label className="checkbox">
          <input
            type="checkbox"
            checked={digitalAccessibleOnly}
            onChange={(event) => setDigitalAccessibleOnly(event.target.checked)}
          />
          Kun digitalt tilgjengelige verk
        </label>

        <label className="checkbox">
          <input
            type="checkbox"
            checked={relativeMode}
            onChange={(event) => setRelativeMode(event.target.checked)}
            disabled={detailMode}
          />
          Relativ visning (% av total per bucket)
        </label>

        {detailMode ? (
          <p className="hint">
            Måned/dag bygges fra `items`-data og er avgrenset til {detailPeriodYears} år.
          </p>
        ) : null}

        <button type="submit" disabled={loading}>
          {loading ? 'Henter...' : 'Hent trend'}
        </button>
      </form>

      {error ? <p className="error">{error}</p> : null}

      {series.length > 0 ? (
        <section className="chart-section">
          <div className="meta">
            <h2>Treff per {granularity === 'year' ? 'år' : granularity === 'month' ? 'måned' : 'dag'}</h2>
            <p>
              Viser {series.length} fraser i perioden {selectedFromYear}-{selectedToYear}.
            </p>
            {series.map((trendSeries) => (
              <p key={trendSeries.phrase}>
                "{trendSeries.phrase}": {trendSeries.totalHits.toLocaleString('nb-NO')} treff
              </p>
            ))}
          </div>

          <div className="chart-wrapper">
            <ResponsiveContainer width="100%" height={360}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="bucket" />
                <YAxis />
                <Tooltip
                  formatter={(value) =>
                    typeof value === 'number'
                      ? relativeMode && !detailMode
                        ? `${value.toFixed(3)} %`
                        : value.toLocaleString('nb-NO')
                      : String(value)
                  }
                  labelFormatter={(label) => `Tid: ${label}`}
                />
                <Legend />
                {chartSeriesConfig.map((seriesConfig) => (
                  <Line
                    key={seriesConfig.dataKey}
                    type="monotone"
                    dataKey={seriesConfig.dataKey}
                    name={seriesConfig.phrase}
                    stroke={seriesConfig.color}
                    strokeWidth={strokeWidth}
                    dot={false}
                    connectNulls
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
        </section>
      ) : (
        <p className="hint">Ingen trend ennå. Kjør et søk for å vise graf.</p>
      )}
    </main>
  )
}

export default App
