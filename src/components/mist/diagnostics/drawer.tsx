'use client'

// DiagnosticsDrawer — the right slide-in systems console (upstream · traces ·
// system · tools · memory · knowledge · voice · skills · agents · evolve ·
// auto · operators · vault). Mounted once at the app shell root; visibility
// and active tab live in the global store.

import { useEffect, useRef } from 'react'
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
  Sparkles,
  Vault as VaultIcon,
  Wrench,
  X,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useMistStore, type DrawerTab } from '@/lib/store'
import { SystemTab } from './system-tab'
import { ToolsTab } from './tools-tab'
import { MemoryTab } from './memory-tab'
import { VoiceTab } from './voice-tab'
import { SkillsTab } from './skills-tab'
import { AgentsTab } from './agents-tab'
import { EvolutionTab } from './evolution-tab'
import { AutomationsTab } from './automations-tab'
import { VaultTab } from './vault-tab'
import { SubagentsTab } from './subagents-tab'
import { TracesTab } from './traces-tab'
import { EfficiencyTab } from './efficiency-tab'
import { KnowledgeTab } from './knowledge-tab'
import { OperatorsTab } from './operators-tab'
import { UpstreamTab } from './upstream-tab'
import { TabBoundary } from './tab-boundary'

// 10-e2 NOTE FOR THE LEAD — store.ts is frozen for this agent, so the newer
// tab ids live in this local superset. Please extend the union in src/lib/store.ts
// (one line) and this type collapses into a harmless no-op superset:
//   export type DrawerTab = 'system' | 'tools' | 'memory' | 'voice' | 'skills' | 'agents' | 'evolve' | 'automations' | 'vault'
//     | 'subagents' | 'upstream' | 'traces' | 'efficiency' | 'knowledge' | 'operators'
// openDrawer only persists the string, so the runtime cast below is safe either way.
type DrawerTabAll =
  | DrawerTab
  | 'automations'
  | 'vault'
  | 'subagents'
  | 'upstream'
  | 'traces'
  | 'efficiency'
  | 'knowledge'
  | 'operators'

const TABS: { value: DrawerTabAll; label: string; icon: LucideIcon }[] = [
  // oj-lab-6: upstream + traces lead — they're the new headline surfaces
  { value: 'upstream', label: 'Upstream', icon: GitBranch },
  { value: 'traces', label: 'Traces', icon: Route },
  { value: 'system', label: 'System', icon: Activity },
  { value: 'efficiency', label: 'Stats', icon: Gauge },
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

export function DiagnosticsDrawer() {
  const drawerOpen = useMistStore((s) => s.drawerOpen)
  const drawerTab = useMistStore((s) => s.drawerTab)
  const openDrawer = useMistStore((s) => s.openDrawer)
  const closeDrawer = useMistStore((s) => s.closeDrawer)
  const scrollContainerRef = useRef<HTMLDivElement>(null)
  // The user's explicit M.I.S.T. preference wins over the OS signal.
  const noMotion = useMistStore((s) => s.reducedMotion)

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
                  upstream · traces · stats · knowledge · operators · system · tools · memory · voice · skills · agents · evolve · auto · vault
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
                  instead of blanking the drawer (12-d1 hardening) */}
              <div 
                ref={scrollContainerRef}
                className="min-h-0 flex-1 overflow-y-auto mist-scroll"
              >
                <TabsContent value="upstream" className="m-0 p-4 focus-visible:outline-none">
                  <TabBoundary label="upstream">
                    <UpstreamTab />
                  </TabBoundary>
                </TabsContent>
                <TabsContent value="traces" className="m-0 p-4 focus-visible:outline-none">
                  <TabBoundary label="traces">
                    <TracesTab />
                  </TabBoundary>
                </TabsContent>
                <TabsContent value="system" className="m-0 p-4 focus-visible:outline-none">
                  <TabBoundary label="system">
                    <SystemTab />
                  </TabBoundary>
                </TabsContent>
                <TabsContent value="efficiency" className="m-0 p-4 focus-visible:outline-none">
                  <TabBoundary label="efficiency">
                    <EfficiencyTab />
                  </TabBoundary>
                </TabsContent>
                <TabsContent value="tools" className="m-0 p-4 focus-visible:outline-none">
                  <TabBoundary label="tools">
                    <ToolsTab />
                  </TabBoundary>
                </TabsContent>
                <TabsContent value="memory" className="m-0 p-4 focus-visible:outline-none">
                  <TabBoundary label="memory">
                    <MemoryTab />
                  </TabBoundary>
                </TabsContent>
                <TabsContent value="knowledge" className="m-0 p-4 focus-visible:outline-none">
                  <TabBoundary label="knowledge">
                    <KnowledgeTab />
                  </TabBoundary>
                </TabsContent>
                <TabsContent value="voice" className="m-0 p-4 focus-visible:outline-none">
                  <TabBoundary label="voice">
                    <VoiceTab />
                  </TabBoundary>
                </TabsContent>
                <TabsContent value="skills" className="m-0 p-4 focus-visible:outline-none">
                  <TabBoundary label="skills">
                    <SkillsTab />
                  </TabBoundary>
                </TabsContent>
                <TabsContent value="agents" className="m-0 p-4 focus-visible:outline-none">
                  <TabBoundary label="agents">
                    <AgentsTab />
                  </TabBoundary>
                </TabsContent>
                <TabsContent value="evolve" className="m-0 p-4 focus-visible:outline-none">
                  <TabBoundary label="evolve">
                    <EvolutionTab />
                  </TabBoundary>
                </TabsContent>
                <TabsContent value="automations" className="m-0 p-4 focus-visible:outline-none">
                  <TabBoundary label="automations">
                    <AutomationsTab />
                  </TabBoundary>
                </TabsContent>
                <TabsContent value="operators" className="m-0 p-4 focus-visible:outline-none">
                  <TabBoundary label="operators">
                    <OperatorsTab />
                  </TabBoundary>
                </TabsContent>
                <TabsContent value="subagents" className="m-0 p-4 focus-visible:outline-none">
                  <TabBoundary label="subagents">
                    <SubagentsTab />
                  </TabBoundary>
                </TabsContent>
                <TabsContent value="vault" className="m-0 p-4 focus-visible:outline-none">
                  <TabBoundary label="vault">
                    <VaultTab />
                  </TabBoundary>
                </TabsContent>
              </div>
            </Tabs>
          </motion.aside>
        </>
      ) : null}
    </AnimatePresence>
  )
}
