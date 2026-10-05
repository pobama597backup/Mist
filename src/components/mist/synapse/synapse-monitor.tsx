'use client'

// SYNAPSE MONITOR — live brain-activity panel fed by the /ws/neural stream.
// Self-contained: subscribes once (handler kept in a ref), renders 6 channel
// ring-buffers (40 samples each), a rolling activity log and a collapse toggle.

import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { ChevronDown } from 'lucide-react'
import { useNeural } from '@/hooks/use-neural'
import { useMistStore } from '@/lib/store'
import { cn } from '@/lib/utils'
import type { SynapseMsg } from '@/lib/types'

const CHANNELS = ['language', 'memory', 'tools', 'vision', 'audio', 'autonomy'] as const
type ChannelName = (typeof CHANNELS)[number]

const BUFFER_SIZE = 40

const CHANNEL_BAR: Record<ChannelName, string> = {
  language: 'bg-purple-400',
  memory: 'bg-emerald-400',
  tools: 'bg-purple-400',
  vision: 'bg-fuchsia-400',
  audio: 'bg-teal-300',
  autonomy: 'bg-amber-300',
}

function seedBuffers(): Record<ChannelName, number[]> {
  const out = {} as Record<ChannelName, number[]>
  for (const c of CHANNELS) out[c] = new Array<number>(BUFFER_SIZE).fill(0)
  return out
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

export function SynapseMonitor() {
  const { onSynapse } = useNeural()
  // The user's explicit M.I.S.T. preference wins over the OS signal.
  const noMotion = useMistStore((s) => s.reducedMotion)

  const [buffers, setBuffers] = useState<Record<ChannelName, number[]>>(seedBuffers)
  const [logs, setLogs] = useState<string[]>([])
  const [lastEventAt, setLastEventAt] = useState<number | null>(null)
  const [everReceived, setEverReceived] = useState(false)
  const [timedOut, setTimedOut] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [now, setNow] = useState<number>(() => Date.now())

  const receivedRef = useRef(false)

  // The live handler lives in a ref so the subscription below never re-registers.
  // The ref is refreshed after every render (latest-ref pattern).
  const handlerRef = useRef<(m: SynapseMsg) => void>(() => {})
  useEffect(() => {
    handlerRef.current = (m: SynapseMsg) => {
      receivedRef.current = true
      setEverReceived(true)
      setLastEventAt(Date.now())
      setBuffers((prev) => {
        const next = { ...prev }
        for (const ch of CHANNELS) {
          const hit = m.channels.find((c) => c.name === ch)
          next[ch] = [...prev[ch].slice(1), hit ? clamp01(hit.value) : 0]
        }
        return next
      })
      if (Array.isArray(m.log)) setLogs(m.log.slice(-6))
    }
  })

  // Subscribe ONCE — the neural socket is a session singleton.
  useEffect(() => {
    const unsub = onSynapse((m) => handlerRef.current(m))
    return unsub
  }, [onSynapse])

  // If no synapse event arrives within 8s of mount the link is considered down.
  useEffect(() => {
    const id = window.setTimeout(() => {
      if (!receivedRef.current) setTimedOut(true)
    }, 8000)
    return () => window.clearTimeout(id)
  }, [])

  // Ticking clock so "last event Xs ago" stays fresh.
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  const linkDown = !everReceived && timedOut
  const secondsAgo = lastEventAt != null ? Math.max(0, Math.round((now - lastEventAt) / 1000)) : null

  return (
    <motion.section
      aria-label="Synapse monitor"
      initial={noMotion ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: noMotion ? 0 : 0.4, ease: 'easeOut' }}
      className="mist-glass flex w-full min-w-0 flex-col gap-3 p-4"
    >
      {/* header */}
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] tracking-[0.25em] text-slate-500">SYNAPSE MONITOR</span>
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5" title="Live neural stream">
            <span className="sr-only">Live neural stream</span>
            <span
              aria-hidden="true"
              className={cn(
                'h-2 w-2 rounded-full',
                linkDown ? 'bg-slate-600' : 'bg-emerald-400 animate-mist-pulse-glow'
              )}
            />
            <span className={cn('font-mono text-[10px]', linkDown ? 'text-slate-500' : 'text-emerald-300/80')}>LIVE</span>
          </span>
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? 'Expand synapse monitor' : 'Collapse synapse monitor'}
            aria-expanded={!collapsed}
            className="flex h-7 w-7 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/5 hover:text-slate-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
          >
            <ChevronDown className={cn('h-4 w-4 transition-transform duration-200', collapsed && 'rotate-180')} />
          </button>
        </div>
      </div>

      {linkDown ? (
        <div className="flex items-center gap-2 py-4 font-mono text-[10px] text-slate-500">
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-slate-500 animate-mist-pulse-glow" />
          awaiting neural link…
        </div>
      ) : (
        <AnimatePresence initial={false} mode="wait">
          {collapsed ? (
            <motion.div
              key="mini"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: noMotion ? 0 : 0.15 }}
              className="flex h-6 items-end gap-1.5"
            >
              {CHANNELS.map((ch) => {
                const v = buffers[ch][BUFFER_SIZE - 1]
                return (
                  <div
                    key={ch}
                    role="img"
                    aria-label={`${ch} ${Math.round(v * 100)} percent`}
                    title={`${ch} · ${Math.round(v * 100)}%`}
                    className={cn('min-w-0 flex-1 rounded-[2px] transition-[height] duration-300', CHANNEL_BAR[ch])}
                    style={{ height: `${Math.max(10, v * 100)}%`, opacity: 0.85 }}
                  />
                )
              })}
            </motion.div>
          ) : (
            <motion.div
              key="full"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: noMotion ? 0 : 0.15 }}
              className="flex min-w-0 flex-col gap-3"
            >
              {/* channel rows */}
              <div className="flex flex-col gap-2">
                {CHANNELS.map((ch) => {
                  const buf = buffers[ch]
                  const current = buf[buf.length - 1]
                  return (
                    <div key={ch} className="flex items-center gap-2">
                      <span className="w-16 shrink-0 font-mono text-[10px] text-slate-500">{ch}</span>
                      <div className="flex h-8 min-w-0 flex-1 items-end gap-[2px]" aria-hidden="true">
                        {buf.map((v, i) => (
                          <div
                            key={i}
                            className={cn('min-w-0 flex-1 rounded-[1px] transition-[height] duration-300', CHANNEL_BAR[ch])}
                            style={{
                              height: `${Math.max(3, v * 100)}%`,
                              opacity: 0.25 + (0.75 * i) / (BUFFER_SIZE - 1),
                            }}
                          />
                        ))}
                      </div>
                      <span className="w-8 shrink-0 text-right font-mono text-[10px] tabular-nums text-slate-400">
                        {Math.round(current * 100)}%
                      </span>
                    </div>
                  )
                })}
              </div>

              {/* rolling log */}
              <div className="flex flex-col gap-0.5 border-t border-white/5 pt-2">
                {logs.length === 0 ? (
                  <span className="font-mono text-[10px] text-slate-500">no activity logged yet</span>
                ) : (
                  logs.map((line, i) => (
                    <span
                      key={`${i}-${line}`}
                      title={line}
                      className={cn(
                        'break-words font-mono text-[10px] leading-snug',
                        i === logs.length - 1 ? 'text-emerald-300/80' : 'text-slate-500'
                      )}
                    >
                      {line}
                    </span>
                  ))
                )}
                {secondsAgo != null ? (
                  <span className="mt-0.5 font-mono text-[10px] text-slate-500">last event {secondsAgo}s ago</span>
                ) : null}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      )}
    </motion.section>
  )
}
