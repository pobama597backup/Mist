'use client'

// VaultTab — the Obsidian second-brain console: vault status, note browser with
// an inline reader (frontmatter + wikilinks + backlinks), ranked search with
// highlighted snippets, a link-graph minimap, dataview-lite queries and daily
// notes. All filesystem access is jailed server-side (/api/mist/obsidian).

import { useEffect, useMemo, useRef, useState } from 'react'
import { motion } from 'framer-motion'
import {
  CalendarPlus,
  ChevronRight,
  Command,
  FolderOpen,
  Link2,
  Loader2,
  Play,
  RefreshCw,
  Search,
  Sparkles,
  Vault,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { mistApi } from '@/lib/mist-api'
import { cn } from '@/lib/utils'
import { MonoBadge, StatusDot, relTime } from './shared'
import type {
  VaultGraph,
  VaultNote,
  VaultNoteMeta,
  VaultQueryResult,
  VaultStatus,
} from '@/lib/types'

// ---------- helpers ----------

interface SearchHit {
  path: string
  title: string
  snippet: string
  score: number
}

type VaultSection = 'notes' | 'graph' | 'query'

/** '/a/b/Note.md' → '/a/b' · root notes → '·' */
function folderOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '· root' : path.slice(0, i)
}

/** middle-truncate long absolute paths so both ends stay readable */
function midTruncate(s: string, max = 46): string {
  if (s.length <= max) return s
  const head = Math.ceil((max - 1) / 2)
  const tail = Math.floor((max - 1) / 2)
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`
}

function tagChip(tag: string): string {
  return tag.startsWith('#') ? tag : `#${tag}`
}

/** bold the query term inside a snippet */
function Highlight({ text, term }: { text: string; term: string }) {
  const t = term.trim()
  if (!t) return <>{text}</>
  const idx = text.toLowerCase().indexOf(t.toLowerCase())
  if (idx === -1) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded bg-purple-400/20 px-0.5 font-semibold text-purple-200">
        {text.slice(idx, idx + t.length)}
      </mark>
      {text.slice(idx + t.length)}
    </>
  )
}

// ---------- graph minimap (SVG · force-lite by degree) ----------

function GraphMiniMap({ graph, onOpen }: { graph: VaultGraph; onOpen: (path: string) => void }) {
  const [hover, setHover] = useState<string | null>(null)

  const layout = useMemo(() => {
    const W = 460
    const H = 300
    const cx = W / 2
    const cy = H / 2
    const orbit = Math.min(W, H) / 2 - 28
    const maxDeg = Math.max(1, ...graph.nodes.map((n) => n.degree))
    // low degree → outer ring, hubs pulled toward the centre
    const sorted = [...graph.nodes].sort((a, b) => a.degree - b.degree)
    const pos = new Map<string, { x: number; y: number }>()
    sorted.forEach((n, i) => {
      const angle = (2 * Math.PI * i) / Math.max(1, sorted.length) - Math.PI / 2
      const r = orbit * (0.25 + 0.75 * (1 - n.degree / maxDeg))
      pos.set(n.id, { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) })
    })
    return { W, H, pos, maxDeg }
  }, [graph.nodes])

  const orphanSet = useMemo(() => new Set(graph.orphans), [graph.orphans])
  const hubSet = useMemo(() => new Set(graph.hubs), [graph.hubs])
  const hovered = hover != null ? graph.nodes.find((n) => n.id === hover) : null

  return (
    <div className="min-w-0">
      <svg
        viewBox={`0 0 ${layout.W} ${layout.H}`}
        className="h-auto w-full"
        role="img"
        aria-label={`Vault link graph — ${graph.nodes.length} notes, ${graph.edges.length} links`}
      >
        {graph.edges.map((e, i) => {
          const a = layout.pos.get(e.source)
          const b = layout.pos.get(e.target)
          if (!a || !b) return null
          return (
            <line
              key={i}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke="rgba(167,139,250,0.22)"
              strokeWidth={1}
            />
          )
        })}
        {graph.nodes.map((n) => {
          const p = layout.pos.get(n.id)
          if (!p) return null
          const isOrphan = orphanSet.has(n.id)
          const isHub = hubSet.has(n.id)
          const r = 3 + 6 * (n.degree / layout.maxDeg)
          const isHover = hover === n.id
          return (
            <g key={n.id}>
              {isHub ? (
                <circle cx={p.x} cy={p.y} r={r + 4} fill="rgba(192,132,252,0.15)" stroke="rgba(192,132,252,0.4)" strokeWidth={1} />
              ) : null}
              <circle
                cx={p.x}
                cy={p.y}
                r={r}
                fill={isOrphan ? 'rgba(100,116,139,0.55)' : isHub ? '#c084fc' : 'rgba(52,211,153,0.85)'}
                stroke={isOrphan ? 'rgba(148,163,184,0.6)' : isHover ? '#f1f5f9' : 'transparent'}
                strokeWidth={isOrphan || isHover ? 1 : 0}
                strokeDasharray={isOrphan ? '2 2' : undefined}
                className="cursor-pointer transition-[fill,stroke]"
                tabIndex={0}
                role="button"
                aria-label={`Open ${n.title}`}
                onMouseEnter={() => setHover(n.id)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(n.id)}
                onBlur={() => setHover(null)}
                onClick={() => onOpen(n.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onOpen(n.id)
                  }
                }}
              >
                <title>{`${n.title} · ${n.degree} link${n.degree === 1 ? '' : 's'}${isOrphan ? ' · orphan' : ''}`}</title>
              </circle>
            </g>
          )
        })}
      </svg>
      <p className="mt-1 min-w-0 truncate font-mono text-[10px] text-slate-500">
        {hovered ? (
          <span className="text-purple-200">
            {hovered.title} · {hovered.degree} link{hovered.degree === 1 ? '' : 's'}
            {orphanSet.has(hovered.id) ? ' · orphan' : ''}
          </span>
        ) : (
          `${graph.nodes.length} notes · ${graph.edges.length} links — hover a node, click to read`
        )}
      </p>
    </div>
  )
}

// ---------- inline note reader ----------

function NoteReader({
  note,
  loadingPath,
  onClose,
  onOpen,
}: {
  note: VaultNote | null
  loadingPath: string | null
  onClose: () => void
  onOpen: (path: string) => void
}) {
  if (note === null) {
    return (
      <div className="mist-glass-soft flex items-center gap-2 rounded-xl p-3.5">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-purple-300" aria-hidden />
        <span className="min-w-0 truncate font-mono text-[11px] text-slate-400">{loadingPath}</span>
      </div>
    )
  }
  const fm = Object.entries(note.frontmatter)
  return (
    <div className="mist-glass-soft animate-mist-fade-in min-w-0 rounded-xl p-3.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="truncate text-sm font-medium text-slate-200">{note.title}</h4>
          <p className="mt-0.5 font-mono text-[9px] text-slate-500">
            {note.path} · edited {relTime(note.mtime)}
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close note"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-white/5 hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
        >
          <X className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>

      {fm.length > 0 ? (
        <div className="mt-2.5 rounded-lg border border-white/5 bg-white/[0.02] p-2">
          {fm.map(([k, v]) => (
            <p key={k} className="flex min-w-0 gap-1.5 font-mono text-[10px] leading-relaxed">
              <span className="shrink-0 text-purple-300/70">{k}:</span>
              <span className="min-w-0 break-words text-slate-300">{v}</span>
            </p>
          ))}
        </div>
      ) : null}

      <pre className="mist-scroll mt-2.5 max-h-64 min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-white/5 bg-white/[0.02] p-2.5 font-mono text-[11px] leading-relaxed text-slate-300">
        {note.content || '(empty note)'}
      </pre>

      {note.outgoingLinks.length > 0 || note.backlinks.length > 0 ? (
        <div className="mt-2.5 space-y-1.5">
          {note.outgoingLinks.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[9px] uppercase tracking-wider text-slate-500">
                <Link2 className="h-3 w-3" aria-hidden /> links
              </span>
              {note.outgoingLinks.map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => onOpen(l)}
                  className="max-w-full truncate rounded-full border border-purple-400/25 bg-purple-400/5 px-1.5 py-0.5 font-mono text-[9px] text-purple-200/90 transition-colors hover:border-purple-400/50 hover:bg-purple-400/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
                >
                  {l.replace(/\.md$/i, '')}
                </button>
              ))}
            </div>
          ) : null}
          {note.backlinks.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="inline-flex shrink-0 items-center gap-1 font-mono text-[9px] uppercase tracking-wider text-slate-500">
                <Link2 className="h-3 w-3 rotate-180" aria-hidden /> backlinks
              </span>
              {note.backlinks.map((l) => (
                <button
                  key={l}
                  type="button"
                  onClick={() => onOpen(l)}
                  className="max-w-full truncate rounded-full border border-teal-400/25 bg-teal-400/5 px-1.5 py-0.5 font-mono text-[9px] text-teal-200/90 transition-colors hover:border-teal-400/50 hover:bg-teal-400/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
                >
                  {l.replace(/\.md$/i, '')}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

// ---------- tab ----------

const QUERY_EXAMPLES = ['LIST FROM #research', 'TASK', 'TABLE status, tags FROM "AI Research"'] as const

export function VaultTab() {
  const [status, setStatus] = useState<VaultStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [reloadKey, setReloadKey] = useState(0)

  const [section, setSection] = useState<VaultSection>('notes')
  const [notes, setNotes] = useState<VaultNoteMeta[] | null>(null)

  const [search, setSearch] = useState('')
  const [searchResults, setSearchResults] = useState<SearchHit[] | null>(null)

  const [note, setNote] = useState<VaultNote | null>(null)
  const [notePath, setNotePath] = useState<string | null>(null)
  const readerRef = useRef<HTMLDivElement | null>(null)

  const [graph, setGraph] = useState<VaultGraph | null>(null)

  const [queryText, setQueryText] = useState('')
  const [queryResult, setQueryResult] = useState<VaultQueryResult | null>(null)
  const [queryRunning, setQueryRunning] = useState(false)

  const [daily, setDaily] = useState<{ path?: string; content?: string; created?: boolean } | null>(null)
  const [dailyBusy, setDailyBusy] = useState(false)

  const [discovered, setDiscovered] = useState<{ found: Array<{ path: string; noteCount: number }>; demoAvailable: boolean } | null>(null)
  const [connectBusy, setConnectBusy] = useState<string | null>(null)
  const [manualPath, setManualPath] = useState('')

  // ---- status ----
  useEffect(() => {
    let alive = true
    mistApi.obsidian
      .status()
      .then((s) => {
        if (alive) {
          setStatus(s)
          setStatusError(null)
        }
      })
      .catch((e) => {
        if (alive) setStatusError(e instanceof Error ? e.message : 'vault service unreachable')
      })
    return () => {
      alive = false
    }
  }, [reloadKey])

  // ---- notes (when connected) ----
  useEffect(() => {
    if (status?.connected !== true) return
    let alive = true
    mistApi.obsidian
      .list()
      .then((r) => {
        if (alive) setNotes(r.notes)
      })
      .catch(() => {
        if (alive) setNotes([])
      })
    return () => {
      alive = false
    }
  }, [status?.connected, reloadKey])

  // ---- discovery (only when definitively disconnected) ----
  useEffect(() => {
    if (status?.connected !== false) return
    let alive = true
    mistApi.obsidian
      .discover()
      .then((r) => {
        if (alive) setDiscovered(r)
      })
      .catch(() => {
        if (alive) setDiscovered({ found: [], demoAvailable: true })
      })
    return () => {
      alive = false
    }
  }, [status?.connected, reloadKey])

  // ---- graph (lazy — first time the graph section opens) ----
  useEffect(() => {
    if (section !== 'graph' || status?.connected !== true || graph !== null) return
    let alive = true
    mistApi.obsidian
      .graph()
      .then((g) => {
        if (alive) setGraph(g)
      })
      .catch(() => {
        if (alive) setGraph({ nodes: [], edges: [], orphans: [], hubs: [] })
      })
    return () => {
      alive = false
    }
  }, [section, status?.connected, graph, reloadKey])

  // ---- debounced search (400ms) ----
  useEffect(() => {
    const q = search.trim()
    let cancelled = false
    const t = setTimeout(() => {
      if (cancelled) return
      if (q === '') {
        setSearchResults(null)
        return
      }
      mistApi.obsidian
        .search(q)
        .then((r) => {
          if (!cancelled) setSearchResults(r.results)
        })
        .catch(() => {
          if (!cancelled) setSearchResults([])
        })
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [search])

  // keep the freshly opened reader in view
  useEffect(() => {
    if (note != null) readerRef.current?.scrollIntoView({ block: 'nearest' })
  }, [note])

  // ---- actions ----

  const resetVaultData = () => {
    setNotes(null)
    setGraph(null)
    setQueryResult(null)
    setDaily(null)
    setNote(null)
    setNotePath(null)
    setSearchResults(null)
    setDiscovered(null)
  }

  const connectPath = (path: string) => {
    setConnectBusy(path)
    mistApi.obsidian
      .setPath(path)
      .then((s) => {
        if (s.connected) {
          toast.success(
            path === 'demo' ? 'Demo vault connected' : `Vault connected — ${s.noteCount} notes`
          )
          setStatus(s)
          resetVaultData()
          setReloadKey((k) => k + 1)
        } else {
          toast.error('Could not connect — is that an Obsidian vault directory?')
        }
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'connect failed'))
      .finally(() => setConnectBusy(null))
  }

  const openNote = (path: string) => {
    setNotePath(path)
    setNote(null)
    mistApi.obsidian
      .read(path)
      .then((r) => {
        if (r.ok) {
          setNote(r.note)
        } else {
          toast.error(r.error)
          setNotePath(null)
        }
      })
      .catch((e) => {
        toast.error(e instanceof Error ? e.message : 'could not read note')
        setNotePath(null)
      })
  }

  const closeNote = () => {
    setNote(null)
    setNotePath(null)
  }

  const onDaily = () => {
    setDailyBusy(true)
    mistApi.obsidian
      .daily()
      .then((r) => {
        if (r.ok && r.path) {
          toast.success(r.created ? `Daily note created — ${r.path}` : `Daily note opened — ${r.path}`)
          setDaily({ path: r.path, content: r.content, created: r.created })
          setReloadKey((k) => k + 1)
        } else {
          toast.error(r.error ?? 'daily note failed')
        }
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'daily note failed'))
      .finally(() => setDailyBusy(false))
  }

  const onRunQuery = () => {
    const q = queryText.trim()
    if (!q) {
      toast.error('Type a dataview-style query first')
      return
    }
    setQueryRunning(true)
    mistApi.obsidian
      .query(q)
      .then((r) => {
        setQueryResult(r)
        if (r.kind === 'unsupported') toast.info('Unsupported query kind — showing best effort')
      })
      .catch((e) => toast.error(e instanceof Error ? e.message : 'query failed'))
      .finally(() => setQueryRunning(false))
  }

  const onManualConnect = () => {
    const p = manualPath.trim()
    if (!p) {
      toast.error('Enter the absolute path to your vault')
      return
    }
    connectPath(p)
  }

  const connected = status?.connected === true
  const queryCols = useMemo(() => {
    const keys: string[] = []
    for (const row of queryResult?.rows ?? []) {
      for (const k of Object.keys(row)) {
        if (!keys.includes(k)) keys.push(k)
      }
    }
    return keys
  }, [queryResult])

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* ---- header ---- */}
      <section aria-labelledby="vault-heading">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3
            id="vault-heading"
            className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.25em] text-slate-500"
          >
            <Vault aria-hidden className="h-3.5 w-3.5" />
            obsidian vault · second brain
          </h3>
          <div className="flex shrink-0 items-center gap-1.5">
            {connected ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={dailyBusy}
                onClick={onDaily}
                className="h-7 gap-1.5 border-teal-400/25 bg-teal-400/10 px-2.5 font-mono text-[10px] text-teal-300 hover:border-teal-400/40 hover:bg-teal-400/15 hover:text-teal-200"
              >
                {dailyBusy ? <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> : <CalendarPlus className="h-3 w-3" aria-hidden />}
                Daily note
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Refresh vault"
              onClick={() => {
                setGraph(null)
                setReloadKey((k) => k + 1)
              }}
              className="h-7 w-7 rounded-lg text-slate-500 hover:bg-white/5 hover:text-slate-300"
            >
              <RefreshCw aria-hidden className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {/* status / discovery */}
        {statusError !== null && status === null ? (
          <div className="mist-glass-soft flex flex-col items-start gap-3 p-4">
            <p className="font-mono text-[11px] text-rose-300/90">vault service unreachable — {statusError}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setReloadKey((k) => k + 1)}
              className="gap-1.5 font-mono text-[11px]"
            >
              <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Retry
            </Button>
          </div>
        ) : status === null ? (
          <div className="mist-glass-soft rounded-xl p-3.5" aria-hidden>
            <Skeleton className="h-4 w-40 bg-white/5" />
            <div className="mt-3 grid grid-cols-5 gap-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 bg-white/5" />
              ))}
            </div>
          </div>
        ) : connected ? (
          <div className="mist-glass-soft mist-glass-hover min-w-0 rounded-xl p-3.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex min-w-0 items-center gap-2">
                <StatusDot className="bg-emerald-400" />
                <span className="font-mono text-[10px] uppercase tracking-widest text-emerald-300">connected</span>
                {status.demo ? (
                  <MonoBadge className="border-teal-400/30 bg-teal-400/10 text-teal-300">demo vault</MonoBadge>
                ) : null}
              </div>
              <span className="shrink-0 font-mono text-[9px] text-slate-500">
                {status.lastScanAt ? `scanned ${relTime(status.lastScanAt)}` : ''}
              </span>
            </div>
            <p className="mt-1.5 truncate font-mono text-[10px] text-slate-400" title={status.vaultPath ?? undefined}>
              {midTruncate(status.vaultPath ?? '—')}
            </p>
            <div className="mt-3 grid grid-cols-5 gap-1.5 text-center">
              {[
                { label: 'notes', value: status.noteCount },
                { label: 'dirs', value: status.folderCount },
                { label: 'tags', value: status.tagCount },
                { label: 'links', value: status.linkCount },
                { label: 'orphans', value: status.orphanCount },
              ].map((s) => (
                <div key={s.label} className="rounded-lg border border-white/5 bg-white/[0.02] px-1 py-1.5">
                  <div
                    className={cn(
                      'font-mono text-base tabular-nums',
                      s.label === 'orphans' && s.value > 0 ? 'text-rose-300' : 'text-purple-300'
                    )}
                  >
                    {s.value}
                  </div>
                  <div className="font-mono text-[8px] uppercase tracking-[0.15em] text-slate-500">{s.label}</div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className="mist-glass-soft min-w-0 rounded-xl p-3.5">
            <div className="flex items-center gap-2">
              <StatusDot className="bg-slate-500" pulse={false} />
              <span className="font-mono text-[10px] uppercase tracking-widest text-slate-400">no vault connected</span>
            </div>

            {discovered === null ? (
              <div className="mt-3 space-y-1.5" aria-hidden>
                <Skeleton className="h-8 w-full bg-white/5" />
                <Skeleton className="h-8 w-2/3 bg-white/5" />
              </div>
            ) : (
              <>
                {discovered.found.length > 0 ? (
                  <div className="mt-2.5 space-y-1.5">
                    {discovered.found.map((v) => (
                      <button
                        key={v.path}
                        type="button"
                        disabled={connectBusy !== null}
                        onClick={() => connectPath(v.path)}
                        className="flex w-full min-w-0 items-center gap-2 rounded-lg border border-white/5 bg-white/[0.02] px-2.5 py-2 text-left transition-colors hover:border-purple-400/30 hover:bg-purple-400/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60 disabled:opacity-50"
                      >
                        <FolderOpen className="h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden />
                        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-slate-300" title={v.path}>
                          {v.path}
                        </span>
                        <MonoBadge className="border-white/10 text-slate-500">{v.noteCount} notes</MonoBadge>
                        {connectBusy === v.path ? (
                          <Loader2 className="h-3 w-3 shrink-0 animate-spin text-purple-300" aria-hidden />
                        ) : (
                          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-slate-500" aria-hidden />
                        )}
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 font-mono text-[10px] leading-relaxed text-slate-500">
                    no vaults found near your home / documents folders — use the demo or connect by path
                  </p>
                )}

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    disabled={connectBusy !== null}
                    onClick={() => connectPath('demo')}
                    className="h-8 gap-1.5 bg-emerald-400/90 px-3 font-mono text-[11px] text-slate-950 hover:bg-emerald-300"
                  >
                    {connectBusy === 'demo' ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                    ) : (
                      <Sparkles className="h-3.5 w-3.5" aria-hidden />
                    )}
                    Use demo vault
                  </Button>
                </div>

                <form
                  className="mt-2.5 flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault()
                    onManualConnect()
                  }}
                >
                  <Input
                    value={manualPath}
                    onChange={(e) => setManualPath(e.target.value)}
                    placeholder="/absolute/path/to/vault"
                    aria-label="Vault path"
                    className="h-8 min-w-0 flex-1 border-white/10 bg-white/5 font-mono text-[11px] text-slate-200 placeholder:text-slate-500"
                  />
                  <Button
                    type="submit"
                    size="sm"
                    variant="outline"
                    disabled={connectBusy !== null}
                    className="h-8 shrink-0 gap-1.5 border-white/15 bg-white/5 px-2.5 font-mono text-[10px] text-slate-300 hover:border-white/30 hover:bg-white/10"
                  >
                    {connectBusy === manualPath.trim() && connectBusy !== null ? (
                      <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                    ) : (
                      <FolderOpen className="h-3 w-3" aria-hidden />
                    )}
                    Connect
                  </Button>
                </form>
              </>
            )}
          </div>
        )}
      </section>

      {/* ---- daily note result ---- */}
      {daily?.path ? (
        <section aria-label="Daily note" className="mist-glass-soft animate-mist-fade-in min-w-0 rounded-xl p-3.5">
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5">
              <CalendarPlus className="h-3.5 w-3.5 shrink-0 text-teal-300" aria-hidden />
              <span className="min-w-0 truncate font-mono text-[10px] text-slate-300" title={daily.path}>
                {daily.path}
              </span>
              {daily.created ? (
                <MonoBadge className="border-emerald-400/30 bg-emerald-400/10 text-emerald-300">new</MonoBadge>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => setDaily(null)}
              aria-label="Close daily note"
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-white/5 hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
            >
              <X className="h-3 w-3" aria-hidden />
            </button>
          </div>
          <pre className="mist-scroll mt-2 max-h-40 min-w-0 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-white/5 bg-white/[0.02] p-2.5 font-mono text-[11px] leading-relaxed text-slate-300">
            {daily.content || '(empty)'}
          </pre>
        </section>
      ) : null}

      {/* ---- connected sections ---- */}
      {connected ? (
        <>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Vault sections">
            {(['notes', 'graph', 'query'] as const).map((s) => {
              const active = section === s
              return (
                <button
                  key={s}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setSection(s)}
                  className={cn(
                    'rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wide transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60',
                    active
                      ? 'border-purple-400/50 bg-purple-400/10 text-purple-200'
                      : 'border-white/10 text-slate-400 hover:border-white/25 hover:text-slate-300'
                  )}
                >
                  {s}
                </button>
              )
            })}
          </div>

          {/* ---- notes ---- */}
          {section === 'notes' ? (
            <section aria-label="Vault notes" className="flex min-w-0 flex-col gap-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" aria-hidden />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="search notes — titles, tags, bodies…"
                  aria-label="Search vault notes"
                  className="h-8 border-white/10 bg-white/5 pl-8 font-mono text-xs text-slate-200 placeholder:text-slate-500"
                />
              </div>

              {search.trim() !== '' ? (
                <div className="mist-scroll max-h-96 min-w-0 space-y-1.5 overflow-y-auto pr-1">
                  {searchResults === null ? (
                    <p className="py-3 text-center font-mono text-[10px] text-slate-500">searching…</p>
                  ) : searchResults.length === 0 ? (
                    <p className="py-3 text-center font-mono text-[10px] text-slate-500">no matches in this vault</p>
                  ) : (
                    searchResults.map((r) => (
                      <button
                        key={r.path}
                        type="button"
                        onClick={() => openNote(r.path)}
                        className="w-full min-w-0 rounded-lg border border-white/5 bg-white/[0.02] px-2.5 py-2 text-left transition-colors hover:border-purple-400/30 hover:bg-purple-400/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="min-w-0 truncate text-xs text-slate-200">{r.title}</span>
                          <MonoBadge className="border-purple-400/25 text-purple-300" title={`score ${r.score.toFixed(2)}`}>
                            {r.score.toFixed(1)}
                          </MonoBadge>
                        </div>
                        <p className="mt-1 line-clamp-2 text-[10px] leading-relaxed text-slate-400">
                          <Highlight text={r.snippet} term={search.trim()} />
                        </p>
                        <p className="mt-0.5 truncate font-mono text-[9px] text-slate-500">{folderOf(r.path)}</p>
                      </button>
                    ))
                  )}
                </div>
              ) : notes === null ? (
                <div className="space-y-1.5" aria-hidden>
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-12 w-full bg-white/5" />
                  ))}
                </div>
              ) : notes.length === 0 ? (
                <p className="py-3 text-center font-mono text-[10px] text-slate-500">vault is empty</p>
              ) : (
                <div className="mist-scroll max-h-96 min-w-0 space-y-1.5 overflow-y-auto pr-1">
                  {notes.map((n) => (
                    <motion.button
                      key={n.path}
                      type="button"
                      initial={{ opacity: 0, y: 4 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.15 }}
                      onClick={() => openNote(n.path)}
                      className="w-full min-w-0 rounded-lg border border-white/5 bg-white/[0.02] px-2.5 py-2 text-left transition-colors hover:border-purple-400/30 hover:bg-purple-400/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="min-w-0 truncate text-xs text-slate-200">{n.title}</span>
                        <span className="shrink-0 font-mono text-[9px] text-slate-500">{relTime(n.mtime)}</span>
                      </div>
                      <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
                        <span className="max-w-full truncate font-mono text-[9px] text-slate-500">{folderOf(n.path)}</span>
                        {n.tags.slice(0, 3).map((t) => (
                          <MonoBadge key={t} className="border-teal-400/25 bg-teal-400/5 text-teal-300">
                            {tagChip(t)}
                          </MonoBadge>
                        ))}
                        {n.tags.length > 3 ? (
                          <span className="font-mono text-[9px] text-slate-500">+{n.tags.length - 3}</span>
                        ) : null}
                        <span className="ml-auto inline-flex shrink-0 items-center gap-0.5 font-mono text-[9px] text-slate-500">
                          <Link2 className="h-3 w-3" aria-hidden />
                          {n.links}
                        </span>
                      </div>
                    </motion.button>
                  ))}
                </div>
              )}
            </section>
          ) : null}

          {/* ---- graph ---- */}
          {section === 'graph' ? (
            <section aria-label="Vault link graph" className="mist-glass-soft min-w-0 rounded-xl p-3.5">
              {graph === null ? (
                <div className="space-y-2" aria-hidden>
                  <Skeleton className="h-44 w-full bg-white/5" />
                  <Skeleton className="h-3 w-2/3 bg-white/5" />
                </div>
              ) : graph.nodes.length === 0 ? (
                <p className="py-3 text-center font-mono text-[10px] text-slate-500">graph unavailable</p>
              ) : (
                <>
                  <GraphMiniMap graph={graph} onOpen={openNote} />
                  {graph.hubs.length > 0 ? (
                    <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                      <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-purple-300/70">hubs</span>
                      {graph.hubs.map((h) => (
                        <button
                          key={h}
                          type="button"
                          onClick={() => openNote(h)}
                          className="max-w-full truncate rounded-full border border-purple-400/25 bg-purple-400/5 px-1.5 py-0.5 font-mono text-[9px] text-purple-200/90 transition-colors hover:border-purple-400/50 hover:bg-purple-400/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
                          title={h}
                        >
                          {h.replace(/\.md$/i, '')}
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {graph.orphans.length > 0 ? (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-rose-300/70">orphans</span>
                      {graph.orphans.map((o) => (
                        <button
                          key={o}
                          type="button"
                          onClick={() => openNote(o)}
                          className="max-w-full truncate rounded-full border border-dashed border-slate-500/40 px-1.5 py-0.5 font-mono text-[9px] text-slate-400 transition-colors hover:border-slate-400/70 hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
                          title={o}
                        >
                          {o.replace(/\.md$/i, '')}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </>
              )}
            </section>
          ) : null}

          {/* ---- query ---- */}
          {section === 'query' ? (
            <section aria-label="Vault query" className="flex min-w-0 flex-col gap-2">
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Example queries">
                {QUERY_EXAMPLES.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => setQueryText(q)}
                    className="rounded-full border border-teal-400/25 bg-teal-400/5 px-2 py-1 font-mono text-[10px] text-teal-200/90 transition-colors hover:border-teal-400/50 hover:bg-teal-400/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
                  >
                    {q}
                  </button>
                ))}
              </div>
              <form
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  onRunQuery()
                }}
              >
                <Textarea
                  value={queryText}
                  onChange={(e) => setQueryText(e.target.value)}
                  placeholder={'LIST FROM #research\nTABLE status, tags FROM "AI Research"\nTASK'}
                  aria-label="Dataview-style query"
                  spellCheck={false}
                  className="h-20 min-w-0 resize-none border-white/5 bg-white/[0.03] font-mono text-[11px] text-slate-200 placeholder:text-slate-500"
                />
                <div className="flex items-center justify-between gap-2">
                  <p className="font-mono text-[9px] leading-relaxed text-slate-500">
                    dataview-lite: LIST · TABLE · TASK — sources #tag, &quot;folder&quot;, [[note]]
                  </p>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={queryRunning}
                    className="h-8 shrink-0 gap-1.5 bg-emerald-400/90 px-3 font-mono text-[11px] text-slate-950 hover:bg-emerald-300"
                  >
                    {queryRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
                    Run
                  </Button>
                </div>
              </form>

              {queryResult !== null ? (
                <div className="mist-glass-soft animate-mist-fade-in min-w-0 rounded-xl p-3.5">
                  <div className="flex items-center justify-between gap-2">
                    <MonoBadge className="border-purple-400/30 bg-purple-400/10 text-purple-300">
                      <Command className="mr-1 h-2.5 w-2.5" aria-hidden />
                      {queryResult.kind}
                    </MonoBadge>
                    <span className="font-mono text-[9px] text-slate-500">{queryResult.rows.length} row(s)</span>
                  </div>
                  {queryResult.explanation ? (
                    <p className="mt-1.5 font-mono text-[9px] leading-relaxed text-slate-500">{queryResult.explanation}</p>
                  ) : null}
                  {queryResult.rows.length === 0 ? (
                    <p className="mt-2 py-2 text-center font-mono text-[10px] text-slate-500">no matches</p>
                  ) : (
                    <div className="mist-scroll mt-2 max-h-72 min-w-0 overflow-auto rounded-lg border border-white/5">
                      <table className="w-full border-collapse text-left font-mono text-[10px]">
                        <thead>
                          <tr className="border-b border-white/5 bg-white/[0.03]">
                            {queryCols.map((c) => (
                              <th key={c} scope="col" className="whitespace-nowrap px-2 py-1.5 font-normal uppercase tracking-wider text-slate-500">
                                {c}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {queryResult.rows.map((row, i) => (
                            <tr key={i} className="border-b border-white/5 last:border-b-0 hover:bg-white/[0.02]">
                              {queryCols.map((c) => (
                                <td key={c} className="max-w-48 truncate px-2 py-1.5 align-top text-slate-300" title={row[c] ?? ''}>
                                  {c === 'path' ? (
                                    <button
                                      type="button"
                                      onClick={() => row[c] && openNote(row[c])}
                                      className="max-w-48 truncate text-left text-purple-300 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
                                    >
                                      {row[c] ?? '—'}
                                    </button>
                                  ) : (
                                    (row[c] ?? '—')
                                  )}
                                </td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              ) : null}
            </section>
          ) : null}

          {/* ---- inline note reader (available from every section) ---- */}
          <div ref={readerRef}>{note != null || notePath != null ? (
            <NoteReader note={note} loadingPath={notePath} onClose={closeNote} onOpen={openNote} />
          ) : null}</div>
        </>
      ) : null}
    </div>
  )
}
