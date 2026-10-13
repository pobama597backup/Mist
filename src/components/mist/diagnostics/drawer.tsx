'use client'

// DiagnosticsDrawer — the right slide-in systems console (upstream · traces ·
// system · tools · memory · knowledge · voice · skills · agents · evolve ·
// auto · operators · vault). Mounted once at the app shell root; visibility
// and active tab live in the global store.
//
// Phase 4-a · P1 (dynamic imports): every tab body is next/dynamic
// (client-only, skeleton while its chunk loads) and mounts ONLY after its
// tab is first opened. Once opened it STAYS mounted — Radix TabsContent
// forceMount keeps the DOM alive (hidden when inactive) so re-entering a
// visited tab is instant and keeps its scroll/state. The mounted-set below
// is the "has this tab ever been opened this drawer session" latch; it
// resets when the drawer unmounts (the close already tore everything down).

import { useEffect, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { AnimatePresence, motion } from 'framer-motion'
import {
  Activity,
  AlarmClock,
  Bot,
  Brain,
  Dna,
  Gauge,
  GitBranch,
  Library,
  Mic,
  Network,
  Radar,
  Route,
  ShieldCheck,
  Sparkles,
  Vault as VaultIcon,
  Wrench,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Skeleton } from '@/components/ui/skeleton'
import { useMistStore, type DrawerTab } from '@/lib/store'
import { TabBoundary } from './tab-boundary'
import type { ComponentType } from 'react'

// v-redesign: the store's DrawerTab union now carries the full 16-tab surface
// (the 10-e2 local-superset debt is closed). This alias is kept so the TABS /
// TAB_BODIES declarations below stay untouched.
type DrawerTabAll = DrawerTab

const TABS: { value: DrawerTabAll; label: string; icon: LucideIcon }[] = [
  // oj-lab-6: upstream + traces lead — they're the new headline surfaces
  { value: 'upstream', label: 'Upstream', icon: GitBranch },
  { value: 'traces', label: 'Traces', icon: Route },
  { value: 'system', label: 'System', icon: Activity },
  { value: 'efficiency', label: 'Stats', icon: Gauge },
  { value: 'control', label: 'Control', icon: ShieldCheck },
  { value: 'tools', label: 'Tools', icon: Wrench },
  { value: 'memory', label: 'Memory', icon: Brain },
  { value: 'knowledge', label: 'Knowledge', icon: Library },
  { value: 'voice', label: 'Voice', icon: Mic },
  { value: 'skills', label: 'Skills', icon: Sparkles },
  { value: 'agents', label: 'Agents', icon: Bot },
  { value: 'subagents', label: 'Sub-agents', icon: Network },
  { value: 'evolve', label: 'Evolve', icon: Dna },
  { value: 'automations', label: 'Auto', icon: AlarmClock },
  { value: 'operators', label: 'Operators', icon: Radar },
  { value: 'vault', label: 'Vault', icon: VaultIcon },
]

/** Shared loading skeleton for a lazily-loading tab body. */
function TabSkeleton() {
  return (
    <div className="space-y-3" aria-hidden>
      <Skeleton className="h-20 w-full rounded-xl bg-white/5" />
      <Skeleton className="h-20 w-full rounded-xl bg-white/5" />
      <Skeleton className="h-6 w-2/5 rounded-lg bg-white/5" />
    </div>
  )
}

/** One dynamic tab: named export → client-only chunk → skeleton bridge. */
function lazyTab(load: () => Promise<Record<string, unknown>>, pick: string) {
  return dynamic(
    () =>
      load().then((m) => {
        const comp = m[pick] as ComponentType | undefined
        if (!comp) throw new Error(`dynamic tab: export "${pick}" missing`)
        return { default: comp }
      }),
    { ssr: false, loading: TabSkeleton }
  )
}

// Phase 4-a · P1: all 15 tab bodies load on first open, never on app boot.
const UpstreamTab = lazyTab(() => import('./upstream-tab'), 'UpstreamTab')
const TracesTab = lazyTab(() => import('./traces-tab'), 'TracesTab')
const SystemTab = lazyTab(() => import('./system-tab'), 'SystemTab')
const EfficiencyTab = lazyTab(() => import('./efficiency-tab'), 'EfficiencyTab')
const ToolsTab = lazyTab(() => import('./tools-tab'), 'ToolsTab')
const MemoryTab = lazyTab(() => import('./memory-tab'), 'MemoryTab')
const KnowledgeTab = lazyTab(() => import('./knowledge-tab'), 'KnowledgeTab')
const VoiceTab = lazyTab(() => import('./voice-tab'), 'VoiceTab')
const SkillsTab = lazyTab(() => import('./skills-tab'), 'SkillsTab')
const AgentsTab = lazyTab(() => import('./agents-tab'), 'AgentsTab')
const SubagentsTab = lazyTab(() => import('./subagents-tab'), 'SubagentsTab')
const EvolutionTab = lazyTab(() => import('./evolution-tab'), 'EvolutionTab')
const AutomationsTab = lazyTab(() => import('./automations-tab'), 'AutomationsTab')
const OperatorsTab = lazyTab(() => import('./operators-tab'), 'OperatorsTab')
const VaultTab = lazyTab(() => import('./vault-tab'), 'VaultTab')
// Phase 6-a: the Control Room (standing orders · audit trail · A4 panel)
const ControlRoomTab = lazyTab(() => import('./control-room-tab'), 'ControlRoomTab')

/** tab id → its lazily-loaded body. */
const TAB_BODIES: Record<DrawerTabAll, ComponentType> = {
  upstream: UpstreamTab,
  traces: TracesTab,
  system: SystemTab,
  efficiency: EfficiencyTab,
  tools: ToolsTab,
  memory: MemoryTab,
  knowledge: KnowledgeTab,
  voice: VoiceTab,
  skills: SkillsTab,
  agents: AgentsTab,
  subagents: SubagentsTab,
  evolve: EvolutionTab,
  automations: AutomationsTab,
  operators: OperatorsTab,
  vault: VaultTab,
  control: ControlRoomTab,
}

export function DiagnosticsDrawer() {
  const drawerOpen = useMistStore((s) => s.drawerOpen)
  const drawerTab = useMistStore((s) => s.drawerTab)
  const openDrawer = useMistStore((s) => s.openDrawer)
  const closeDrawer = useMistStore((s) => s.closeDrawer)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  // The user's explicit M.I.S.T. preference wins over the OS signal.
  const noMotion = useMistStore((s) => s.reducedMotion)

  // Phase 4-a · P1 "mount active only, keep mounted": the set of tabs that
  // have been opened during THIS drawer session. A tab joins on first
  // activation and never leaves — hidden via Radix's forceMount, so switching
  // back is instant and state survives. (Adjust-during-render latch — the
  // documented pattern; no effect, no cascading renders, strict-mode safe.)
  const [openedTabs, setOpenedTabs] = useState<Set<DrawerTabAll>>(() => new Set())
  const activeTab = drawerTab as DrawerTabAll
  if (!openedTabs.has(activeTab)) {
    setOpenedTabs((prev) => new Set(prev).add(activeTab))
  }

  // Escape closes the drawer.
  useEffect(() => {
    if (!drawerOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDrawer()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawerOpen, closeDrawer])

  // Reset scroll when drawer opens or tab changes. Deferred one frame:
  // when the new tab's content changes the container height, the browser's
  // scroll-anchoring restores the old offset AFTER a synchronous reset —
  // requestAnimationFrame lands after anchoring, before paint.
  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    const raf = requestAnimationFrame(() => {
      el.scrollTop = 0
    })
    return () => cancelAnimationFrame(raf)
  }, [drawerOpen, drawerTab])

  return (
    <AnimatePresence>
      {drawerOpen ? (
        <>
          <motion.div
            key="mist-drawer-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: noMotion ? 0 : 0.2 }}
            onClick={closeDrawer}
            aria-hidden="true"
            className="fixed inset-0 z-40 bg-black/60"
          />

          <motion.aside
            key="mist-drawer-panel"
            role="dialog"
            aria-modal="true"
            aria-label="Diagnostics drawer"
            initial={noMotion ? false : { x: '100%' }}
            animate={{ x: 0 }}
            exit={noMotion ? { opacity: 0 } : { x: '100%' }}
            transition={noMotion ? { duration: 0 } : { type: 'tween', duration: 0.3, ease: [0.32, 0.72, 0, 1] }}
            className="mist-scanlines fixed inset-y-0 right-0 z-50 flex w-[min(560px,92vw)] min-w-0 flex-col border-l border-white/10 bg-slate-950/95 shadow-2xl backdrop-blur-2xl"
          >
            {/* header */}
            <div className="flex items-center justify-between gap-3 border-b border-white/10 p-4">
              <div className="min-w-0">
                <h2 className="font-mono text-xs tracking-[0.3em] text-slate-300">DIAGNOSTICS</h2>
                <p className="mt-0.5 truncate font-mono text-[10px] text-slate-500">
                  upstream · traces · stats · control · knowledge · operators · system · tools · memory · voice · skills · agents · evolve · auto · vault
                </p>
              </div>
              <button
                type="button"
                onClick={closeDrawer}
                aria-label="Close diagnostics"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
              >
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>

            {/* tabs */}
            <Tabs
              value={drawerTab}
              onValueChange={(v) => openDrawer(v as DrawerTab)}
              className="flex min-h-0 flex-1 flex-col"
            >
              <div className="border-b border-white/10 px-4 py-3">
                <TabsList className="grid h-auto w-full grid-cols-5 gap-1 rounded-xl border border-white/5 bg-white/5 p-1">
                  {TABS.map((t) => (
                    <TabsTrigger
                      key={t.value}
                      value={t.value}
                      className="h-8 min-w-0 rounded-lg px-1 font-mono text-[10px] uppercase tracking-wider text-slate-400 transition-colors data-[state=active]:bg-white/10 data-[state=active]:text-slate-100 data-[state=active]:shadow-none hover:text-slate-200 sm:text-[11px]"
                    >
                      <t.icon aria-hidden="true" className="h-3 w-3 shrink-0" />
                      <span className="min-w-0 truncate">{t.label}</span>
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>

              {/* each panel is isolated — a render error shows a retry card
                  instead of blanking the drawer (12-d1 hardening). forceMount
                  keeps visited tabs alive (hidden by Radix when inactive);
                  the body itself mounts only after first open. */}
              <div
                ref={scrollContainerRef}
                className="min-h-0 flex-1 overflow-y-auto mist-scroll"
              >
                {TABS.map((t) => {
                  const Body = TAB_BODIES[t.value]
                  const mounted = openedTabs.has(t.value)
                  return (
                    <TabsContent
                      key={t.value}
                      value={t.value}
                      forceMount
                      className="m-0 p-4 focus-visible:outline-none data-[state=inactive]:hidden"
                    >
                      <TabBoundary label={t.value}>
                        {mounted ? <Body /> : null}
                      </TabBoundary>
                    </TabsContent>
                  )
                })}
              </div>
            </Tabs>
          </motion.aside>
        </>
      ) : null}
    </AnimatePresence>
  )
}
