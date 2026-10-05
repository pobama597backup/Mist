'use client'

// M.I.S.T. top command bar — identity + primary tab navigation. The left block
// keeps the live mini orb and the brand; the right block is a real TAB system
// (Consciousness · Chat · Self) followed by the global actions (Browser ·
// Diagnostics · Settings). Mobile 390px: all six icon buttons fit in one row
// next to the brand — zero horizontal overflow.
// Task 3-b → 12-d1 · tab-bar navigation

import { useEffect, useState } from 'react'
import {
  Activity,
  BrainCircuit,
  Globe,
  MessageSquare,
  Settings,
  Sparkles,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { useMistStore, type MistView } from '@/lib/store'
import { useBackendStatus } from '@/hooks/use-backend'
import { STATE_COLORS } from '@/lib/mist-constants'
import { mistApi } from '@/lib/mist-api'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

/** Primary view tabs — pill buttons, active state carries the purple pill. */
const VIEW_TABS: { id: MistView; label: string; icon: LucideIcon }[] = [
  { id: 'consciousness', label: 'Consciousness', icon: Sparkles },
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'self', label: 'Self', icon: BrainCircuit },
]

/** ~28px live consciousness orb — reflects neural.state in real time. */
function NeuralMiniOrb() {
  const state = useMistStore((s) => s.neural.state)
  const setView = useMistStore((s) => s.setView)
  const color = STATE_COLORS[state]
  const busy = state === 'processing' || state === 'speaking' || state === 'awakening'

  return (
    <button
      type="button"
      aria-label="Return to Consciousness"
      onClick={() => setView('consciousness')}
      className="relative flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
    >
      {/* orbiting conic ring while the mind is busy */}
      {busy ? (
        <span
          aria-hidden
          className="absolute -inset-1.5 animate-mist-orbit-fast rounded-full"
          style={{
            background: `conic-gradient(from 0deg, transparent 0%, ${color}99 14%, transparent 32%)`,
            WebkitMask:
              'radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px))',
            mask: 'radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px))',
          }}
        />
      ) : null}
      <span
        aria-hidden
        className={cn(
          'absolute inset-0 rounded-full animate-mist-pulse-glow',
          state === 'speaking' && 'animate-mist-bounce-soft'
        )}
        style={{ background: `radial-gradient(circle at 35% 35%, ${color}88, transparent 72%)` }}
      />
      <span
        aria-hidden
        className={cn(
          'relative h-4.5 w-4.5 rounded-full transition-colors duration-500',
          state === 'speaking' && 'animate-mist-bounce-soft'
        )}
        style={{
          background: `radial-gradient(circle at 35% 35%, ${color}, transparent 70%)`,
          boxShadow: `0 0 14px ${color}`,
        }}
      />
      <span className="sr-only">Neural core — {state}</span>
    </button>
  )
}

export function MistNavbar() {
  const connected = useMistStore((s) => s.neural.connected)
  const view = useMistStore((s) => s.view)
  const setView = useMistStore((s) => s.setView)
  const openDrawer = useMistStore((s) => s.openDrawer)
  const browserOpen = useMistStore((s) => s.browser.open)
  const browserTabs = useMistStore((s) => s.browser.tabs)
  const setBrowserOpen = useMistStore((s) => s.setBrowserOpen)
  const openBrowserTab = useMistStore((s) => s.openBrowserTab)
  const backend = useBackendStatus()

  // pending self-evolution proposals (badge) — lightweight poll, auto-suggestions surface here
  const [evolutionPending, setEvolutionPending] = useState(0)
  useEffect(() => {
    let alive = true
    const poll = () => {
      mistApi.evolution
        .list()
        .then((r) => {
          if (alive) setEvolutionPending(r.stats.pending)
        })
        .catch(() => undefined)
    }
    poll()
    const t = setInterval(poll, 90_000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  const onBrowserToggle = () => {
    if (browserTabs.length === 0) {
      openBrowserTab({ url: 'about:blank', title: 'Browser Cockpit', kind: 'cockpit' })
    } else {
      setBrowserOpen(!browserOpen)
    }
  }

  return (
    <header className="sticky top-0 z-30 h-16 w-full border-b border-white/10 bg-slate-950/70 backdrop-blur-xl">
      {/* traveling shine along the bottom edge */}
      <span aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-px overflow-hidden">
        <span className="mist-pan-shine block h-full w-1/3 bg-gradient-to-r from-transparent via-purple-300/60 to-transparent" />
      </span>
      <div className="mx-auto flex h-full max-w-[1800px] items-center justify-between gap-2 px-2 sm:gap-4 sm:px-6">
        {/* LEFT — live orb + identity */}
        <div className="flex min-w-0 shrink-0 items-center gap-1.5 sm:gap-3">
          <NeuralMiniOrb />
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="text-sm font-semibold tracking-[0.2em] text-slate-100 sm:tracking-[0.25em]">
              M.I.S.T.
            </span>
            <span className="hidden font-mono text-[10px] tracking-widest text-slate-500 lg:block">
              MASTER INTELLIGENCE &amp; SYSTEM TOPOLOGY
            </span>
          </div>
        </div>

        {/* RIGHT — primary tabs · divider · global actions */}
        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          {/* neural link chip — folded away below sm (status bar keeps the
              socket dot); tooltip + icon on sm→lg; icon + label at lg+ */}
          <Tooltip>
            <TooltipTrigger asChild>
              <div
                role="status"
                aria-label={`neural link ${connected ? 'online' : 'offline'}`}
                className="hidden h-9 items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-2.5 sm:flex"
              >
                <Zap
                  aria-hidden
                  className={cn('h-3.5 w-3.5', connected ? 'text-emerald-400' : 'text-slate-500')}
                />
                <span
                  className={cn(
                    'hidden font-mono text-[10px] uppercase tracking-widest lg:inline',
                    connected ? 'text-emerald-400/80' : 'text-slate-500'
                  )}
                >
                  {connected ? 'link' : 'down'}
                </span>
              </div>
            </TooltipTrigger>
            <TooltipContent side="bottom">neural link</TooltipContent>
          </Tooltip>

          {/* primary view tabs */}
          <nav aria-label="Primary views" className="flex shrink-0 items-center gap-0.5 md:gap-1">
            {VIEW_TABS.map(({ id, label, icon: Icon }) => {
              const active = view === id
              return (
                <button
                  key={id}
                  type="button"
                  aria-current={active ? 'page' : undefined}
                  aria-label={label}
                  onClick={() => setView(id)}
                  className={cn(
                    'relative flex h-11 w-10 shrink-0 items-center justify-center gap-2 rounded-lg transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60 md:w-auto md:px-3',
                    active
                      ? 'bg-purple-400/15 text-purple-200'
                      : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
                  )}
                >
                  <Icon aria-hidden className="h-4.5 w-4.5 shrink-0" />
                  <span className="hidden text-xs md:inline">{label}</span>
                  {active ? (
                    <span
                      aria-hidden
                      className="absolute bottom-0.5 left-1/2 h-0.5 w-5 -translate-x-1/2 rounded-full bg-purple-300/80"
                    />
                  ) : null}
                </button>
              )
            })}
          </nav>

          <span aria-hidden className="hidden h-6 w-px bg-white/10 sm:block" />

          {/* global actions */}
          <div className="flex shrink-0 items-center gap-0.5 lg:gap-1">
            <button
              type="button"
              aria-label={`In-app browser (${browserTabs.length} tabs)`}
              onClick={onBrowserToggle}
              className={cn(
                'relative flex h-11 w-10 shrink-0 items-center justify-center gap-2 rounded-lg transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60 lg:w-auto lg:px-3',
                browserOpen
                  ? 'bg-purple-400/15 text-purple-200'
                  : 'text-slate-400 hover:bg-white/5 hover:text-slate-100'
              )}
            >
              <Globe aria-hidden className="h-4.5 w-4.5 shrink-0" />
              <span className="hidden text-xs lg:inline">Browser</span>
              {browserTabs.length > 0 ? (
                <span
                  aria-hidden
                  className="absolute right-1 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-purple-400 px-1 font-mono text-[9px] font-semibold text-slate-950 lg:right-2"
                >
                  {browserTabs.length}
                </span>
              ) : null}
            </button>

            <button
              type="button"
              aria-label={
                evolutionPending > 0
                  ? `Open diagnostics (${evolutionPending} evolution proposals awaiting review)`
                  : 'Open diagnostics'
              }
              onClick={() => openDrawer(evolutionPending > 0 ? 'evolve' : 'system')}
              className="relative flex h-11 w-10 shrink-0 items-center justify-center gap-2 rounded-lg text-slate-400 transition-colors duration-150 hover:bg-white/5 hover:text-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60 lg:w-auto lg:px-3"
            >
              <Activity aria-hidden className="h-4.5 w-4.5 shrink-0" />
              <span className="hidden text-xs lg:inline">Diagnostics</span>
              {evolutionPending > 0 ? (
                <span
                  aria-hidden
                  className="absolute right-1 top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-400 px-1 font-mono text-[9px] font-semibold text-slate-950 lg:right-2"
                >
                  {evolutionPending}
                </span>
              ) : null}
              <span
                aria-hidden
                className={cn(
                  'absolute bottom-1.5 left-1/2 h-1.5 w-1.5 -translate-x-1/2 rounded-full lg:left-3 lg:translate-x-0',
                  backend.online ? 'bg-emerald-400' : 'bg-rose-400'
                )}
              />
            </button>

            <button
              type="button"
              aria-label={view === 'settings' ? 'Back to consciousness' : 'Open settings'}
              onClick={() => setView(view === 'settings' ? 'consciousness' : 'settings')}
              className={cn(
                'relative flex h-11 w-10 shrink-0 items-center justify-center rounded-lg transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60',
                view === 'settings'
                  ? 'bg-purple-400/15 text-purple-200'
                  : 'text-slate-400 hover:bg-white/5 hover:text-slate-100'
              )}
            >
              <Settings aria-hidden className="h-4.5 w-4.5" />
              {view === 'settings' ? (
                <span
                  aria-hidden
                  className="absolute bottom-0.5 left-1/2 h-0.5 w-5 -translate-x-1/2 rounded-full bg-purple-300/80"
                />
              ) : null}
            </button>
          </div>
        </div>
      </div>
    </header>
  )
}
