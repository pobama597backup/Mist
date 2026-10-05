'use client'

// M.I.S.T. — ConsciousnessHub: the Consciousness view.
// One adaptive tree (single ChatPanel/NeuralCore instance → single socket
// listener): xl+ docks threads · synapse · orb · chat; lg floats synapse;
// below lg collapses to orb + chat with a slide-in threads overlay.
// Task 3-b · frontend core

import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Activity, PanelLeft, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react'
import { useMistStore } from '@/lib/store'
import { PROVIDER_LABELS } from '@/lib/mist-constants'
import { SynapseMonitor } from '@/components/mist/synapse/synapse-monitor'
import { ThreadsSidebar } from './threads-sidebar'
import { NeuralCore } from './neural-core'
import { ChatPanel } from './chat-panel'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

export function ConsciousnessHub() {
  const threadsCollapsed = useMistStore((s) => s.threadsCollapsed)
  const toggleThreads = useMistStore((s) => s.toggleThreads)
  const synapseOpen = useMistStore((s) => s.synapseOpen)
  const setSynapseOpen = useMistStore((s) => s.setSynapseOpen)
  const provider = useMistStore((s) => s.provider)

  // The user's explicit M.I.S.T. preference wins over the OS signal.
  const reduced = useMistStore((s) => s.reducedMotion)

  // Mobile threads overlay (local state so it never pops open on first load —
  // store.threadsCollapsed stays dedicated to the lg+ sidebar collapse).
  const [mobileThreadsOpen, setMobileThreadsOpen] = useState(false)

  useEffect(() => {
    if (!mobileThreadsOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileThreadsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mobileThreadsOpen])

  return (
    <div className="h-full min-h-0 w-full animate-mist-fade-in">
      {/* compact header — mobile only */}
      <div className="mb-4 flex items-center justify-between gap-3 lg:hidden">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Open threads"
          onClick={() => setMobileThreadsOpen(true)}
          className="mist-glass-soft h-11 w-11 rounded-xl text-slate-300 hover:border-white/20 hover:text-slate-100 focus-visible:ring-purple-400/60"
        >
          <PanelLeft aria-hidden className="h-5 w-5" />
        </Button>
        <span className="truncate font-mono text-[10px] uppercase tracking-[0.25em] text-slate-500">
          via {PROVIDER_LABELS[provider]}
        </span>
      </div>

      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[12rem_minmax(0,1fr)_21rem] xl:grid-cols-[13rem_15rem_minmax(0,1fr)_23rem] 2xl:grid-cols-[14rem_16rem_minmax(0,1fr)_26rem]">
        {/* threads column — lg+ (collapsible at any size) */}
        <motion.div
          className="hidden min-w-0 lg:block"
          initial={reduced ? false : { opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: 'spring', stiffness: 150, damping: 20, delay: 0.05 }}
        >
          {threadsCollapsed ? (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Toggle threads"
              title="Expand threads"
              onClick={toggleThreads}
              className="mist-glass-soft h-9 w-9 rounded-xl text-slate-400 hover:border-white/20 hover:text-slate-100 focus-visible:ring-purple-400/60"
            >
              <PanelLeftOpen aria-hidden className="h-4 w-4" />
            </Button>
          ) : (
            <div className="flex min-w-0 flex-col gap-2">
              <div className="flex justify-end pr-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label="Toggle threads"
                  title="Collapse threads"
                  onClick={toggleThreads}
                  className="h-8 w-8 rounded-lg text-slate-500 hover:bg-white/5 hover:text-slate-200 focus-visible:ring-purple-400/60"
                >
                  <PanelLeftClose aria-hidden className="h-4 w-4" />
                </Button>
              </div>
              <ThreadsSidebar />
            </div>
          )}
        </motion.div>

        {/* synapse column — xl+ docked */}
        <motion.div
          className="hidden min-w-0 xl:block"
          initial={reduced ? false : { opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: 'spring', stiffness: 150, damping: 20, delay: 0.12 }}
        >
          <div className="mist-scroll sticky top-20 max-h-[calc(100vh-12rem)] overflow-y-auto">
            <SynapseMonitor />
          </div>
        </motion.div>

        {/* center — the orb */}
        <motion.div
          className="flex min-h-[45vh] min-w-0 flex-col items-center justify-center gap-5 py-2 lg:min-h-[60vh] lg:py-6"
          initial={reduced ? false : { opacity: 0, scale: 0.92 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ type: 'spring', stiffness: 130, damping: 18, delay: 0.08 }}
        >
          <div className="scale-[0.88] transition-transform duration-300 lg:scale-100">
            <NeuralCore />
          </div>
        </motion.div>

        {/* chat column */}
        <motion.div
          className="h-[65vh] min-w-0 lg:sticky lg:top-20 lg:h-[calc(100vh-11rem)]"
          initial={reduced ? false : { opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: 'spring', stiffness: 150, damping: 20, delay: 0.16 }}
        >
          <ChatPanel className="h-full" />
        </motion.div>
      </div>

      {/* mobile threads overlay */}
      <AnimatePresence>
        {mobileThreadsOpen && (
          <motion.div
            key="threads-backdrop"
            className="fixed inset-0 z-40 bg-black/60 lg:hidden"
            initial={reduced ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={reduced ? undefined : { opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => setMobileThreadsOpen(false)}
            aria-hidden
          />
        )}
        {mobileThreadsOpen && (
          <motion.div
            key="threads-panel"
            role="dialog"
            aria-label="Threads"
            className="mist-glass-strong fixed inset-y-0 left-0 z-40 w-72 p-4 pt-16 lg:hidden"
            initial={reduced ? false : { x: '-100%' }}
            animate={{ x: 0 }}
            exit={reduced ? undefined : { x: '-100%' }}
            transition={{ type: 'tween', duration: 0.25, ease: 'easeOut' }}
          >
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Close threads"
              onClick={() => setMobileThreadsOpen(false)}
              className="absolute right-3 top-4 h-9 w-9 rounded-lg text-slate-400 hover:bg-white/5 hover:text-slate-100 focus-visible:ring-purple-400/60"
            >
              <X aria-hidden className="h-4 w-4" />
            </Button>
            <ThreadsSidebar />
          </motion.div>
        )}
      </AnimatePresence>

      {/* floating synapse toggle — lg range only (xl docks it) */}
      <div className="fixed bottom-16 left-4 z-30 hidden lg:flex xl:hidden">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Toggle synapse monitor"
          onClick={() => setSynapseOpen(!synapseOpen)}
          className={cn(
            'mist-glass h-11 w-11 rounded-xl text-slate-300 hover:border-white/25 hover:text-slate-100 focus-visible:ring-purple-400/60',
            synapseOpen && 'border-purple-400/40 bg-purple-400/10 text-purple-200'
          )}
        >
          <Activity aria-hidden className="h-5 w-5" />
        </Button>
      </div>

      {/* floating synapse panel — lg range only */}
      <AnimatePresence>
        {synapseOpen && (
          <motion.div
            key="synapse-panel"
            className="fixed bottom-24 left-4 z-30 hidden w-72 lg:block xl:hidden"
            initial={reduced ? false : { opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? undefined : { opacity: 0, y: 12 }}
            transition={{ duration: 0.2 }}
          >
            <SynapseMonitor />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
