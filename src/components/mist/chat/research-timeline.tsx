'use client'

// M.I.S.T. — ResearchTimeline (oj-face-5, OpenJarvis UX port).
//
// Vertical timeline of the deep-research pipeline persisted in research-mode
// message meta: query plan → searches → sources read (credibility colors) →
// synthesis. HONEST: renders NOTHING when the meta is absent — legacy
// research messages (before this field existed) keep their citations-only
// rendering; no pipeline is ever synthesized client-side.

import { useState } from 'react'
import { AlertTriangle, Check, ChevronDown, CircleDashed, FileSearch, ListChecks, Search, Telescope } from 'lucide-react'
import { cn } from '@/lib/utils'
import { fmtDuration } from '@/lib/oj/ui-api'

/** The research pipeline snapshot persisted onto the assistant message meta. */
export interface ResearchPipelineMeta {
  status: 'done' | 'error' | string
  depth: number
  phases: Array<{ name: string; status: 'pending' | 'active' | 'done' | 'error' }>
  queries: string[]
  sources: Array<{
    title: string
    url: string
    host: string
    credibility: 'high' | 'medium' | 'low'
    read: boolean
  }>
  pagesRead: number
  elapsedMs: number
}

/** Guard: only render for meta that actually looks like a research pipeline. */
function isPipelineMeta(v: unknown): v is ResearchPipelineMeta {
  if (!v || typeof v !== 'object') return false
  const m = v as Partial<ResearchPipelineMeta>
  return Array.isArray(m.phases) && Array.isArray(m.queries) && Array.isArray(m.sources)
}

const CREDIBILITY_DOT: Record<string, string> = {
  high: 'bg-emerald-400/90',
  medium: 'bg-amber-300/90',
  low: 'bg-rose-400/90',
}

const CREDIBILITY_LABEL: Record<string, string> = {
  high: 'high credibility',
  medium: 'medium credibility',
  low: 'low credibility',
}

/** Phase display names — mirrors the research-console vocabulary. */
const PHASE_LABEL: Record<string, string> = {
  planning: 'query plan',
  searching: 'web searches',
  reading: 'sources read',
  synthesizing: 'synthesis',
  done: 'report',
}

function PhaseIcon({ status }: { status: string }) {
  if (status === 'done') return <Check aria-hidden className="h-3 w-3" />
  if (status === 'error') return <AlertTriangle aria-hidden className="h-3 w-3" />
  if (status === 'active') return <CircleDashed aria-hidden className="h-3 w-3 animate-mist-pulse-glow" />
  return <CircleDashed aria-hidden className="h-3 w-3 opacity-40" />
}

function phaseNodeClass(status: string): string {
  if (status === 'done') return 'border-emerald-300/40 bg-emerald-300/10 text-emerald-300'
  if (status === 'error') return 'border-rose-400/40 bg-rose-400/10 text-rose-300'
  if (status === 'active') return 'border-fuchsia-400/40 bg-fuchsia-400/10 text-fuchsia-300'
  return 'border-white/10 bg-white/5 text-slate-500'
}

export function ResearchTimeline({ research }: { research?: ResearchPipelineMeta | null }) {
  const [open, setOpen] = useState(false)
  if (!research || !isPipelineMeta(research)) return null

  const errored = research.status === 'error' || research.phases.some((p) => p.status === 'error')
  const readSources = research.sources.filter((s) => s.read)

  return (
    <div className="mist-glass-soft mt-2 overflow-hidden rounded-xl">
      {/* summary row — always visible */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="research-timeline-body"
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
      >
        <span
          aria-hidden
          className={cn(
            'flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border',
            errored
              ? 'border-rose-400/30 bg-rose-400/10 text-rose-300'
              : 'border-fuchsia-400/30 bg-fuchsia-400/10 text-fuchsia-300'
          )}
        >
          {errored ? <AlertTriangle className="h-3.5 w-3.5" /> : <Telescope className="h-3.5 w-3.5" />}
        </span>
        <span className="min-w-0 flex-1">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-fuchsia-300/90">research pipeline</span>
          <span className="ml-2 truncate font-mono text-[10px] text-slate-500">
            {research.queries.length} {research.queries.length === 1 ? 'query' : 'queries'} ·{' '}
            {research.sources.length} sources · {research.pagesRead} read
            {research.elapsedMs > 0 ? ` · ${fmtDuration(research.elapsedMs)}` : ''}
            {research.depth === 2 ? ' · depth 2' : ''}
          </span>
        </span>
        <ChevronDown
          aria-hidden
          className={cn('h-4 w-4 shrink-0 text-slate-500 transition-transform duration-200', open && 'rotate-180')}
        />
      </button>

      {/* expanded vertical timeline */}
      {open ? (
        <div id="research-timeline-body" className="border-t border-white/5 px-3 pb-3 pt-3">
          <ol className="relative space-y-3" aria-label="Research pipeline events">
            {/* left rail */}
            <span aria-hidden className="absolute bottom-2 left-[11px] top-2 w-px bg-white/10" />

            {/* query plan — the planned searches */}
            {research.queries.length > 0 ? (
              <li className="relative flex gap-3">
                <span aria-hidden className={cn('relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border', phaseNodeClass('done'))}>
                  <ListChecks className="h-3 w-3" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-[10px] uppercase tracking-wider text-slate-400">query plan</p>
                  <ul className="mt-1 space-y-0.5">
                    {research.queries.map((q, i) => (
                      <li key={`q-${i}`} className="truncate font-mono text-[11px] text-slate-300" title={q}>
                        <span className="text-slate-600">{String(i + 1).padStart(2, '0')}</span> {q}
                      </li>
                    ))}
                  </ul>
                </div>
              </li>
            ) : null}

            {/* the recorded phases */}
            {research.phases
              .filter((p) => p.name !== 'planning' || research.queries.length === 0)
              .map((p) => (
                <li key={p.name} className="relative flex gap-3">
                  <span
                    aria-hidden
                    className={cn('relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border', phaseNodeClass(p.status))}
                  >
                    {p.name === 'searching' ? (
                      <Search className="h-3 w-3" />
                    ) : p.name === 'reading' ? (
                      <FileSearch className="h-3 w-3" />
                    ) : (
                      <PhaseIcon status={p.status} />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p
                      className={cn(
                        'font-mono text-[10px] uppercase tracking-wider',
                        p.status === 'error' ? 'text-rose-300/90' : 'text-slate-400'
                      )}
                    >
                      {PHASE_LABEL[p.name] ?? p.name}
                      <span className="ml-2 normal-case tracking-normal text-slate-600">
                        {p.status === 'done' ? 'completed' : p.status}
                      </span>
                    </p>

                    {/* reading phase → the sources with credibility colors */}
                    {p.name === 'reading' && research.sources.length > 0 ? (
                      <ul className="mist-scroll mt-1.5 max-h-64 space-y-1 overflow-y-auto pr-1" aria-label="Sources">
                        {research.sources.map((s, i) => (
                          <li key={`s-${i}`} className="flex min-w-0 items-start gap-1.5">
                            <span
                              aria-hidden
                              title={CREDIBILITY_LABEL[s.credibility] ?? s.credibility}
                              className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', CREDIBILITY_DOT[s.credibility] ?? 'bg-slate-500')}
                            />
                            <a
                              href={s.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="min-w-0 flex-1 truncate text-[11px] text-slate-300 underline-offset-2 transition-colors hover:text-purple-200 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
                              title={`${s.title} — ${s.host}`}
                            >
                              {s.title || s.url}
                            </a>
                            <span className="shrink-0 font-mono text-[10px] text-slate-500">{s.host}</span>
                            {s.read ? (
                              <span title="read" className="shrink-0 text-emerald-400/90">
                                <Check aria-hidden className="h-3 w-3" />
                              </span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    ) : null}

                    {/* synthesis stats line */}
                    {p.name === 'synthesizing' ? (
                      <p className="mt-0.5 font-mono text-[11px] text-slate-500">
                        {readSources.length} of {research.sources.length} sources cited · inline [n] references
                      </p>
                    ) : null}
                  </div>
                </li>
              ))}
          </ol>
        </div>
      ) : null}
    </div>
  )
}
