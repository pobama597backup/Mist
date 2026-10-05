'use client'

// KnowledgeTab — Clare's OpenJarvis knowledge base manager: hybrid
// BM25 + vector search (RRF-fused), manual ingestion, and the honest
// connector grid (live local sources sync, OAuth ones say what they need).

import { useCallback, useEffect, useState } from 'react'
import {
  BookOpen,
  ChevronDown,
  Database,
  FileUp,
  Library,
  Link2,
  Loader2,
  RefreshCw,
  Search,
  SearchX,
  TriangleAlert,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import {
  ojApi,
  type ConnectorInfo,
  type KnowledgeSearchResult,
} from '@/lib/oj/lab-api'
import { MonoBadge, SectionLabel, relTime } from './shared'

// ---------- helpers ----------

function clampPct(v: number): number {
  return Math.max(3, Math.min(100, v * 100))
}

function fmtScore(v: number): string {
  if (v === 0) return '0'
  if (v < 0.01) return v.toFixed(4)
  return v.toFixed(2)
}

// ---------- search result card ----------

function SearchResultCard({ result, maxScore }: { result: KnowledgeSearchResult; maxScore: number }) {
  const [open, setOpen] = useState(false)
  const fusedPct = maxScore > 0 ? clampPct(result.score / maxScore) : 0
  return (
    <article className="mist-glass-soft rounded-xl p-3">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-slate-200" title={result.title || result.source}>
          {result.title || '(untitled chunk)'}
        </span>
        <MonoBadge className="border-white/10 text-slate-500">{result.source}</MonoBadge>
      </div>
      {/* fused score bar */}
      <div className="mt-2" role="img" aria-label={`fused score ${fmtScore(result.score)}`}>
        <div className="flex items-center justify-between font-mono text-[9px] text-slate-600">
          <span>fused score</span>
          <span className="tabular-nums text-purple-300">{fmtScore(result.score)}</span>
        </div>
        <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
          <div className="h-full rounded-full bg-purple-400/80 transition-all duration-500" style={{ width: `${fusedPct}%` }} />
        </div>
      </div>
      {/* bm25 / vector split */}
      <div className="mt-1.5 grid grid-cols-2 gap-2">
        <div>
          <div className="flex items-center justify-between font-mono text-[9px] text-slate-600">
            <span>bm25</span>
            <span className="tabular-nums text-teal-300">{fmtScore(result.bm25)}</span>
          </div>
          <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-teal-300/70" style={{ width: `${clampPct(result.bm25)}%` }} />
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between font-mono text-[9px] text-slate-600">
            <span>vector</span>
            <span className="tabular-nums text-emerald-300">{fmtScore(result.vector)}</span>
          </div>
          <div className="mt-0.5 h-1 w-full overflow-hidden rounded-full bg-white/10">
            <div className="h-full rounded-full bg-emerald-400/70" style={{ width: `${clampPct(result.vector)}%` }} />
          </div>
        </div>
      </div>
      {/* content preview / expand */}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={`${open ? 'Collapse' : 'Expand'} content of ${result.title || result.source}`}
        className="mt-2 flex w-full items-start gap-1.5 rounded-lg bg-white/[0.02] px-2.5 py-1.5 text-left transition-colors hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
      >
        <span className={cn('min-w-0 flex-1 font-mono text-[10px] leading-relaxed text-slate-400', !open && 'line-clamp-2')}>
          {result.content}
        </span>
        <ChevronDown aria-hidden className={cn('mt-0.5 h-3 w-3 shrink-0 text-slate-600 transition-transform', open && 'rotate-180')} />
      </button>
      {open ? (
        <pre className="mist-scroll mt-1.5 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-950/60 p-2.5 font-mono text-[10px] leading-relaxed text-slate-400">
          {result.content}
        </pre>
      ) : null}
    </article>
  )
}

// ---------- connector card ----------

function ConnectorCard({
  connector,
  syncing,
  onSync,
}: {
  connector: ConnectorInfo
  syncing: boolean
  onSync: (id: string) => void
}) {
  const status = connector.connected
    ? { dot: 'bg-emerald-400', label: 'connected', cls: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' }
    : connector.available
      ? { dot: 'bg-amber-300', label: 'needs setup', cls: 'border-amber-400/30 bg-amber-400/10 text-amber-300' }
      : { dot: 'bg-slate-500', label: 'not configured', cls: 'border-white/10 bg-white/5 text-slate-500' }
  return (
    <article className="mist-glass-soft rounded-xl p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className={cn('inline-block h-2 w-2 shrink-0 rounded-full', status.dot)} aria-hidden="true" />
          <span className="min-w-0 truncate text-[12px] font-medium text-slate-200">{connector.name}</span>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <MonoBadge className="border-white/10 text-slate-600">{connector.kind}</MonoBadge>
          <span className={cn('rounded-full border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide', status.cls)}>
            {status.label}
          </span>
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[9px] text-slate-500">
        <span className="tabular-nums">{connector.items} doc{connector.items === 1 ? '' : 's'} ingested</span>
        <span>{connector.lastSyncAt ? `synced ${relTime(connector.lastSyncAt)}` : 'never synced'}</span>
      </div>
      <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-slate-500">{connector.note}</p>
      <Button
        variant="outline"
        size="sm"
        disabled={syncing}
        onClick={() => onSync(connector.id)}
        className="mt-2 h-7 border-white/10 bg-white/5 px-2 font-mono text-[9px] uppercase tracking-widest text-slate-300 hover:border-purple-400/40 hover:text-purple-200"
        aria-label={`Sync ${connector.name} now`}
      >
        {syncing ? <Loader2 aria-hidden className="h-3 w-3 animate-spin" /> : <RefreshCw aria-hidden className="h-3 w-3" />}
        sync now
      </Button>
    </article>
  )
}

// ---------- the tab ----------

export function KnowledgeTab() {
  // search
  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchRan, setSearchRan] = useState(false)
  const [results, setResults] = useState<KnowledgeSearchResult[] | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)

  // ingest
  const [source, setSource] = useState('')
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [ingesting, setIngesting] = useState(false)

  // connectors
  const [connectors, setConnectors] = useState<ConnectorInfo[] | null>(null)
  const [connectorsLoading, setConnectorsLoading] = useState(true)
  const [connectorsError, setConnectorsError] = useState<string | null>(null)
  const [syncingId, setSyncingId] = useState<string | null>(null)

  const refreshConnectors = useCallback(async () => {
    setConnectorsLoading(true)
    try {
      const res = await ojApi.connectors.list()
      setConnectors(res.connectors)
      setConnectorsError(null)
    } catch (e) {
      setConnectorsError(e instanceof Error ? e.message : 'connector registry unreachable')
    } finally {
      setConnectorsLoading(false)
    }
  }, [])

  useEffect(() => {
    refreshConnectors()
  }, [refreshConnectors])

  const runSearch = async (e?: React.FormEvent) => {
    e?.preventDefault()
    const q = query.trim()
    if (!q) {
      toast.error('type something to search for first')
      return
    }
    setSearching(true)
    setSearchError(null)
    try {
      const res = await ojApi.knowledge.search(q, { topK: 8 })
      setResults(res.results)
      setSearchRan(true)
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : 'knowledge search failed')
      setResults(null)
    } finally {
      setSearching(false)
    }
  }

  const ingest = async (e?: React.FormEvent) => {
    e?.preventDefault()
    const src = source.trim()
    const body = text.trim()
    if (!src || !body) {
      toast.error('ingest needs at least a source and the text')
      return
    }
    setIngesting(true)
    try {
      const res = await ojApi.knowledge.ingest({ source: src, title: title.trim() || undefined, text: body })
      toast.success(`ingested ${res.chunks} chunk${res.chunks === 1 ? '' : 's'} into the knowledge store`)
      setSource('')
      setTitle('')
      setText('')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'ingest failed')
    } finally {
      setIngesting(false)
    }
  }

  const syncConnector = async (id: string) => {
    setSyncingId(id)
    try {
      const res = await ojApi.connectors.sync(id)
      const r = res.result
      if (r?.ok) {
        const detail = r.ingested !== undefined ? `${r.ingested} doc${r.ingested === 1 ? '' : 's'} ingested${r.skipped ? `, ${r.skipped} skipped` : ''}` : 'synced'
        toast.success(`${res.connector.name}: ${detail}${r.note ? ` — ${r.note}` : ''}`)
      } else {
        toast.error(`${id}: sync reported an honest failure — ${(res.connector.note || 'see the connector note')}`)
      }
      await refreshConnectors()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'sync failed')
    } finally {
      setSyncingId(null)
    }
  }

  const maxScore = results && results.length > 0 ? Math.max(...results.map((r) => r.score)) : 0

  return (
    <div className="space-y-3">
      <SectionLabel>
        <span className="inline-flex items-center gap-1.5">
          <Library aria-hidden className="h-3 w-3 text-slate-500" />
          knowledge base
        </span>
      </SectionLabel>

      {/* ---- search ---- */}
      <form onSubmit={runSearch} className="mist-glass-soft p-2.5" role="search" aria-label="hybrid knowledge search">
        <div className="flex items-center gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search her knowledge — bm25 + vector, fused…"
            aria-label="knowledge search query"
            className="h-8 min-w-0 flex-1 border-white/10 bg-white/5 font-mono text-[11px]"
          />
          <Button
            type="submit"
            disabled={searching}
            className="h-8 shrink-0 border border-purple-400/30 bg-purple-400/15 px-3 font-mono text-[10px] uppercase tracking-widest text-purple-200 hover:bg-purple-400/25"
          >
            {searching ? <Loader2 aria-hidden className="h-3 w-3 animate-spin" /> : <Search aria-hidden className="h-3 w-3" />}
            search
          </Button>
        </div>
      </form>

      {searching ? (
        <div className="space-y-2" aria-busy="true" aria-label="searching knowledge">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-36 w-full rounded-xl" />
          ))}
        </div>
      ) : searchError ? (
        <p role="alert" className="flex items-center gap-1.5 rounded-xl bg-rose-950/20 px-2.5 py-2 font-mono text-[10px] text-rose-300/90">
          <TriangleAlert aria-hidden className="h-3.5 w-3.5 shrink-0" />
          {searchError}
        </p>
      ) : results !== null ? (
        results.length === 0 ? (
          <div className="mist-glass rounded-xl p-5 text-center">
            <SearchX aria-hidden className="mx-auto h-5 w-5 text-slate-600" />
            <p className="mt-2 text-sm text-slate-300">nothing in the store matches “{query.trim()}”</p>
            <p className="mt-1 text-[11px] text-slate-600">ingest something below, or try a different phrasing</p>
          </div>
        ) : (
          <div className="mist-scroll max-h-[60vh] space-y-2 overflow-y-auto pr-1" aria-label="search results">
            {results.map((r) => (
              <SearchResultCard key={r.id} result={r} maxScore={maxScore} />
            ))}
          </div>
        )
      ) : null}

      {/* ---- ingest ---- */}
      <SectionLabel>
        <span className="inline-flex items-center gap-1.5">
          <FileUp aria-hidden className="h-3 w-3 text-slate-500" />
          ingest manually
        </span>
      </SectionLabel>
      <form onSubmit={ingest} className="mist-glass-soft space-y-2.5 p-2.5" aria-label="manual ingestion">
        <div className="grid grid-cols-2 gap-2">
          <div className="min-w-0 space-y-1">
            <Label htmlFor="kj-source" className="font-mono text-[9px] uppercase tracking-widest text-slate-600">
              source *
            </Label>
            <Input
              id="kj-source"
              value={source}
              onChange={(e) => setSource(e.target.value)}
              placeholder="e.g. manual, docs"
              className="h-8 border-white/10 bg-white/5 font-mono text-[11px]"
            />
          </div>
          <div className="min-w-0 space-y-1">
            <Label htmlFor="kj-title" className="font-mono text-[9px] uppercase tracking-widest text-slate-600">
              title
            </Label>
            <Input
              id="kj-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="optional"
              className="h-8 border-white/10 bg-white/5 font-mono text-[11px]"
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label htmlFor="kj-text" className="font-mono text-[9px] uppercase tracking-widest text-slate-600">
            text *
          </Label>
          <Textarea
            id="kj-text"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="paste knowledge here — it's chunked heading-aware, ~800 chars per chunk with overlap"
            rows={4}
            className="mist-scroll min-h-20 border-white/10 bg-white/5 font-mono text-[11px]"
          />
        </div>
        <div className="flex items-center justify-between gap-2">
          <p className="font-mono text-[9px] text-slate-600">re-ingesting the same source replaces it (no duplicates)</p>
          <Button
            type="submit"
            disabled={ingesting}
            className="h-8 shrink-0 border border-purple-400/30 bg-purple-400/15 px-3 font-mono text-[10px] uppercase tracking-widest text-purple-200 hover:bg-purple-400/25"
          >
            {ingesting ? <Loader2 aria-hidden className="h-3 w-3 animate-spin" /> : <FileUp aria-hidden className="h-3 w-3" />}
            ingest
          </Button>
        </div>
      </form>

      {/* ---- connectors ---- */}
      <SectionLabel
        right={
          <span className="font-mono text-[10px] text-slate-600">
            {connectors ? `${connectors.filter((c) => c.connected).length}/${connectors.length} connected` : '…'}
          </span>
        }
      >
        <span className="inline-flex items-center gap-1.5">
          <Link2 aria-hidden className="h-3 w-3 text-slate-500" />
          connectors
        </span>
      </SectionLabel>
      {connectorsLoading ? (
        <div className="space-y-2" aria-busy="true" aria-label="loading connectors">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-32 w-full rounded-xl" />
          ))}
        </div>
      ) : connectorsError ? (
        <div role="alert" className="mist-glass rounded-xl p-4">
          <p className="flex items-center gap-2 text-sm text-rose-300">
            <TriangleAlert aria-hidden className="h-4 w-4" />
            connector registry unreachable
          </p>
          <p className="mt-1 font-mono text-[10px] text-slate-500">{connectorsError}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-3 h-8 border-white/10 bg-white/5 font-mono text-[10px] uppercase tracking-widest"
            onClick={() => refreshConnectors()}
          >
            <RefreshCw aria-hidden className="h-3 w-3" />
            Retry
          </Button>
        </div>
      ) : connectors === null || connectors.length === 0 ? (
        <div className="mist-glass rounded-xl p-5 text-center">
          <BookOpen aria-hidden className="mx-auto h-5 w-5 text-slate-600" />
          <p className="mt-2 text-sm text-slate-300">no connectors registered</p>
        </div>
      ) : (
        <div className="mist-scroll max-h-[60vh] space-y-2 overflow-y-auto pr-1" aria-label="connector list">
          {connectors.map((c) => (
            <ConnectorCard key={c.id} connector={c} syncing={syncingId === c.id} onSync={syncConnector} />
          ))}
        </div>
      )}

      <p className="flex items-start gap-1.5 px-1 font-mono text-[9px] leading-relaxed text-slate-600">
        <Database aria-hidden className="mt-0.5 h-3 w-3 shrink-0" />
        hybrid search = BM25 + TF-cosine vector signal fused with reciprocal rank fusion (k=60). connectors without
        credentials stay honestly disconnected — their notes say exactly what they'd need.
      </p>
    </div>
  )
}
