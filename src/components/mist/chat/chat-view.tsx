'use client'

// M.I.S.T. — ChatView: the full-screen Chat tab (v6 wave 1).
// Chat gets its own roomy surface: threads docked lg+ (collapsible via the
// store flag), below lg a slide-in overlay (local state — the hub pattern,
// never popping open on first load), and the ChatPanel filling the remaining
// width/height. The panel centers its message stream in a max-w-3xl column
// internally, so this view stays simple: sidebar + roomy conversation.
// Task 12-c · chat tab

import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { PanelLeft, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react'
import { useMistStore } from '@/lib/store'
import { PROVIDER_LABELS } from '@/lib/mist-constants'
import { ThreadsSidebar } from '@/components/mist/consciousness/threads-sidebar'
import { ChatPanel } from '@/components/mist/consciousness/chat-panel'
import { Button } from '@/components/ui/button'

export function ChatView() {
  const threadsCollapsed = useMistStore((s) => s.threadsCollapsed)
  const toggleThreads = useMistStore((s) => s.toggleThreads)
  const provider = useMistStore((s) => s.provider)

  // The user's explicit M.I.S.T. preference wins over the OS signal.
  const reduced = useMistStore((s) => s.reducedMotion)

  // Mobile threads overlay (local state so it never pops open on first load —
  // store.threadsCollapsed stays dedicated to the lg+ sidebar collapse).
  const [mobileThreadsOpen, setMobileThreadsOpen] = useState(false)

  // Escape closes the mobile threads overlay.
  useEffect(() => {
    if (!mobileThreadsOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMobileThreadsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mobileThreadsOpen])

  return (
    // Full-height flex column: the parent supplies h-full; the max-height cap
    // keeps the composer inside the viewport even when the parent overflows.
    <div className="animate-mist-fade-in flex h-full max-h-[calc(100vh-11rem)] min-h-0 w-full flex-col">
      <div className="flex min-h-0 flex-1 gap-4">
        {/* threads column — lg+ docked, collapsible at any size.
            FIXED WIDTH LADDER (mlv-lead-4): the aside used to have no width
            class, so flex base sizing fell back to max-content — one long
            unbroken thread title blew it to ~21,000px, pushed the whole
            conversation offscreen and dragged the collapse button with it
            ("the thread tab covers everything with no X button"). A fixed
            ladder + overflow-hidden makes the column structural again. */}
        <motion.aside
          aria-label="Threads"
          className="hidden w-60 min-w-0 shrink-0 flex-col overflow-hidden lg:flex xl:w-64 2xl:w-72"
          initial={reduced ? false : { opacity: 0, x: -14 }}
          animate={{ opacity: 1, x: 0 }}
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
            <div className="flex h-full min-h-0 flex-col gap-2">
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
              <ThreadsSidebar className="h-full min-h-0 flex-1" />
            </div>
          )}
        </motion.aside>

        {/* chat column — the roomy full-height conversation */}
        <motion.section
          aria-label="Conversation with M.I.S.T."
          className="flex min-h-0 min-w-0 flex-1 flex-col"
          initial={reduced ? false : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ type: 'spring', stiffness: 150, damping: 20, delay: 0.08 }}
        >
          {/* compact header row — mobile only (threads live behind the overlay) */}
          <div className="mb-3 flex items-center justify-between gap-3 lg:hidden">
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
              chat · via {PROVIDER_LABELS[provider]}
            </span>
          </div>

          <ChatPanel className="h-full min-h-0 flex-1" />
        </motion.section>
      </div>

      {/* mobile threads overlay — slide-in panel with backdrop */}
      <AnimatePresence>
        {mobileThreadsOpen && (
          <motion.div
            key="chat-threads-backdrop"
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
            key="chat-threads-panel"
            role="dialog"
            aria-label="Threads"
            className="mist-glass-strong fixed inset-y-0 left-0 z-40 w-80 p-4 pt-16 lg:hidden"
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
    </div>
  )
}
