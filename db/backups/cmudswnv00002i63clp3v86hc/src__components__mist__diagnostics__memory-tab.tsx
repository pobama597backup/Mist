'use client'

// MemoryTab — long-term facts, semantic vector search and the processing queue.

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Loader2, Plus, Search, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { mistApi } from '@/lib/mist-api'
import { cn } from '@/lib/utils'
import { MonoBadge, SectionLabel, relTime } from './shared'
import type { MemoryFact, MemoryQueueItem, MemoryStats, VectorSearchResult } from '@/lib/types'

const KIND_BADGE: Record<string, string> = {
  reminder: 'border-amber-300/30 bg-amber-300/10 text-amber-200',
  note: 'border-teal-300/30 bg-teal-300/10 text-teal-200',
  staged: 'border-white/10 bg-white/5 text-slate-400',
}

function distanceBadgeClass(distance: number): string {
  if (distance <= 0.4) return 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300'
  if (distance <= 0.7) return 'border-amber-300/30 bg-amber-300/10 text-amber-200'
  return 'border-white/10 bg-white/5 text-slate-400'
}

function sourceOf(metadata: Record<string, unknown>): string {
  const raw = metadata?.source ?? metadata?.kind ?? metadata?.role
  return typeof raw === 'string' && raw.length > 0 ? raw : 'vector'
}

export function MemoryTab() {
  const [stats, setStats] = useState<MemoryStats | null>(null)
  const [facts, setFacts] = useState<MemoryFact[] | null>(null)
  const [queue, setQueue] = useState<MemoryQueueItem[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)

  const [keyInput, setKeyInput] = useState('')
  const [valueInput, setValueInput] = useState('')
  const [addingFact, setAddingFact] = useState(false)
  const [busyKey, setBusyKey] = useState<string | null>(null)

  const [query, setQuery] = useState('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<VectorSearchResult[] | null>(null)
  const [noVectors, setNoVectors] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [s, f, q] = await Promise.all([
        mistApi.memory.stats(),
        mistApi.memory.longterm.list(),
        mistApi.memory.queue(),
      ])
      setStats(s)
      setFacts(f)
      setQueue(q)
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'memory core unreachable')
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  const addFact = async () => {
    const key = keyInput.trim()
    const value = valueInput.trim()
    if (!key || !value) {
      toast.error('A fact needs both a key and a value')
      return
    }
    setAddingFact(true)
    try {
      await mistApi.memory.longterm.set(key, value)
      toast.success(`Fact "${key}" committed to long-term memory`)
      setKeyInput('')
      setValueInput('')
      await refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to store fact')
    } finally {
      setAddingFact(false)
    }
  }

  const removeFact = async (key: string) => {
    setBusyKey(key)
    try {
      await mistApi.memory.longterm.remove(key)
      toast.success(`Fact "${key}" forgotten`)
      await refresh()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to remove fact')
    } finally {
      setBusyKey(null)
    }
  }

  const runSearch = async () => {
    const q = query.trim()
    if (!q) {
      toast.error('Type a phrase to search for')
      return
    }
    setSearching(true)
    setNoVectors(false)
    try {
      const res = await mistApi.memory.vectorSearch(q, 5)
      setResults(res.results)
    } catch {
      if ((stats?.vector_count ?? 0) === 0) {
        setResults([])
        setNoVectors(true)
      } else {
        toast.error('Vector search unavailable')
      }
    } finally {
      setSearching(false)
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {loadError && facts === null ? (
        <div className="mist-glass-soft flex flex-col items-start gap-3 p-4">
          <p className="font-mono text-[11px] text-rose-300/90">memory core unreachable — {loadError}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void refresh()} className="font-mono text-[11px]">
            Retry
          </Button>
        </div>
      ) : null}

      {/* ---- stats ---- */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'LONG-TERM', value: stats ? `${stats.longterm_count}` : null },
          { label: 'QUEUE', value: stats ? `${stats.queue_count}` : null },
          { label: 'VECTORS', value: stats ? `${stats.vector_count}` : null },
        ].map((s) => (
          <motion.div
            key={s.label}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className="mist-glass-soft mist-glass-hover p-3 text-center"
          >
            <div className="font-mono text-xl tabular-nums text-purple-300">
              {s.value ?? <Skeleton className="mx-auto h-6 w-8 bg-white/5" />}
            </div>
            <div className="mt-0.5 font-mono text-[10px] tracking-[0.2em] text-slate-500">{s.label}</div>
          </motion.div>
        ))}
      </div>

      {/* ---- long-term facts ---- */}
      <section aria-label="Long-term facts" className="flex min-w-0 flex-col gap-2">
        <SectionLabel>long-term facts</SectionLabel>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void addFact()
          }}
        >
          <Input
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder="key"
            aria-label="Fact key"
            className="h-9 w-28 shrink-0 border-white/10 bg-white/5 font-mono text-xs text-slate-200 placeholder:text-slate-500"
            maxLength={64}
          />
          <Input
            value={valueInput}
            onChange={(e) => setValueInput(e.target.value)}
            placeholder="value"
            aria-label="Fact value"
            className="h-9 min-w-0 flex-1 border-white/10 bg-white/5 font-mono text-xs text-slate-200 placeholder:text-slate-500"
            maxLength={500}
          />
          <Button
            type="submit"
            size="sm"
            disabled={addingFact}
            className="h-9 shrink-0 gap-1.5 bg-purple-400/90 font-mono text-[11px] text-slate-950 hover:bg-purple-300"
          >
            {addingFact ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Plus className="h-3.5 w-3.5" aria-hidden="true" />}
            Add
          </Button>
        </form>

        <div className="max-h-56 min-w-0 space-y-1.5 overflow-y-auto mist-scroll pr-1">
          {facts === null ? (
            Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-8 w-full bg-white/5" />)
          ) : facts.length === 0 ? (
            <p className="py-3 text-center font-mono text-[11px] text-slate-500">No facts held yet</p>
          ) : (
            facts.map((f) => (
              <div key={f.key} className="flex min-w-0 items-center gap-2 rounded-lg border border-white/5 bg-white/[0.02] px-2.5 py-1.5">
                <span className="w-32 shrink-0 truncate font-mono text-xs text-emerald-300" title={f.key}>
                  {f.key}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-slate-300" title={f.value}>
                  {f.value}
                </span>
                <span className="shrink-0 text-[10px] text-slate-500">{relTime(f.created_at)}</span>
                <button
                  type="button"
                  onClick={() => void removeFact(f.key)}
                  disabled={busyKey === f.key}
                  aria-label={`Delete ${f.key}`}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-rose-400/10 hover:text-rose-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60 disabled:opacity-40"
                >
                  {busyKey === f.key ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                </button>
              </div>
            ))
          )}
        </div>
      </section>

      {/* ---- vector search ---- */}
      <section aria-label="Vector memory search" className="flex min-w-0 flex-col gap-2">
        <SectionLabel>semantic recall</SectionLabel>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void runSearch()
          }}
        >
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="search impressions by meaning…"
            aria-label="Vector search query"
            className="h-9 min-w-0 flex-1 border-white/10 bg-white/5 font-mono text-xs text-slate-200 placeholder:text-slate-500"
          />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={searching}
            className="h-9 shrink-0 gap-1.5 border-purple-400/25 bg-purple-400/10 font-mono text-[11px] text-purple-200 hover:border-purple-400/40 hover:bg-purple-400/15"
          >
            {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Search className="h-3.5 w-3.5" aria-hidden="true" />}
            Search
          </Button>
        </form>

        {results != null ? (
          <div className="min-w-0 space-y-1.5">
            {results.length === 0 ? (
              <p className="py-2 text-xs text-slate-500">
                {noVectors
                  ? 'No vector impressions yet — they accumulate as you converse.'
                  : 'No matching impressions for that phrase.'}
              </p>
            ) : (
              results.map((r, i) => (
                <div key={i} className="flex min-w-0 items-start gap-2 rounded-lg border border-white/5 bg-white/[0.02] px-2.5 py-2">
                  <p className="min-w-0 flex-1 text-xs leading-relaxed text-slate-300 line-clamp-2">{r.text}</p>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    <MonoBadge className={distanceBadgeClass(r.distance)} title={`distance ${r.distance.toFixed(3)}`}>
                      {r.distance.toFixed(2)}
                    </MonoBadge>
                    <MonoBadge className="border-white/10 text-slate-500">{sourceOf(r.metadata)}</MonoBadge>
                  </span>
                </div>
              ))
            )}
          </div>
        ) : null}
      </section>

      {/* ---- queue ---- */}
      <section aria-label="Memory queue" className="flex min-w-0 flex-col gap-2">
        <SectionLabel
          right={
            queue.length > 0 ? (
              <span className="font-mono text-[10px] text-slate-500">{queue.length} pending</span>
            ) : null
          }
        >
          processing queue
        </SectionLabel>
        {queue.length === 0 ? (
          <p className="py-2 font-mono text-[11px] text-slate-500">queue clear — nothing awaiting consolidation</p>
        ) : (
          <div className="max-h-40 min-w-0 space-y-1.5 overflow-y-auto mist-scroll pr-1">
            {queue.map((item) => (
              <div key={item.id} className="flex min-w-0 items-center gap-2 rounded-lg border border-white/5 bg-white/[0.02] px-2.5 py-1.5">
                <span className="min-w-0 flex-1 truncate text-xs text-slate-300" title={item.content}>
                  {item.content}
                </span>
                <MonoBadge className={cn(KIND_BADGE[item.kind] ?? KIND_BADGE.staged)}>{item.kind}</MonoBadge>
                <span className="shrink-0 text-[10px] text-slate-500">{relTime(item.created_at)}</span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
