'use client'

// M.I.S.T. — ThreadsSidebar: conversation list backed by mistApi.conversations.
// Reloads on store.threadsRefreshSeq bumps; skeletons on first load only.
// Task 3-b · frontend core

import { useCallback, useEffect, useState } from 'react'
import { Plus, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { useMistStore } from '@/lib/store'
import { mistApi } from '@/lib/mist-api'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

/** Compact relative time — "3m ago" style (mono readout aesthetic). */
function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (Number.isNaN(ms)) return ''
  const s = Math.max(0, ms / 1000)
  if (s < 60) return `${Math.floor(s)}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  if (s < 604800) return `${Math.floor(s / 86400)}d ago`
  return new Date(iso).toLocaleDateString()
}

export function ThreadsSidebar({ className }: { className?: string }) {
  const list = useMistStore((s) => s.threads.list)
  const activeId = useMistStore((s) => s.threads.activeId)
  const loading = useMistStore((s) => s.threads.loading)
  const refreshSeq = useMistStore((s) => s.threadsRefreshSeq)
  const setThreads = useMistStore((s) => s.setThreads)
  const setActiveThread = useMistStore((s) => s.setActiveThread)
  const threadsLoading = useMistStore((s) => s.threadsLoading)
  const bumpThreadsRefresh = useMistStore((s) => s.bumpThreadsRefresh)

  const [error, setError] = useState(false)
  const [creating, setCreating] = useState(false)

  const load = useCallback(async () => {
    threadsLoading(true)
    setError(false)
    try {
      const threads = await mistApi.conversations.list()
      setThreads(threads)
    } catch {
      setError(true)
    } finally {
      threadsLoading(false)
    }
  }, [setThreads, threadsLoading])

  useEffect(() => {
    void load()
  }, [load, refreshSeq])

  const create = async () => {
    if (creating) return
    setCreating(true)
    try {
      const conv = await mistApi.conversations.create('New thread')
      setActiveThread(conv.id)
      bumpThreadsRefresh()
    } catch {
      toast.error('Could not create thread')
    } finally {
      setCreating(false)
    }
  }

  const showSkeleton = loading && list.length === 0

  return (
    <div className={cn('flex min-w-0 flex-col gap-2', className)}>
      <div className="flex items-center justify-between pr-1">
        <span className="font-mono text-[10px] tracking-[0.25em] text-slate-500">THREADS</span>
        <button
          type="button"
          onClick={() => void create()}
          disabled={creating}
          aria-label="New thread"
          className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/5 hover:text-purple-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60 disabled:opacity-50"
        >
          <Plus aria-hidden className="h-4 w-4" />
        </button>
      </div>

      {showSkeleton ? (
        <div className="space-y-1.5" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 w-full rounded-xl bg-white/5" />
          ))}
        </div>
      ) : error ? (
        <div className="flex items-center justify-between gap-2 rounded-xl border border-rose-400/20 bg-rose-400/5 p-3">
          <span className="text-xs text-slate-500">threads unreachable</span>
          <button
            type="button"
            onClick={() => void load()}
            aria-label="Retry loading threads"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-slate-400 transition-colors hover:bg-white/5 hover:text-rose-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
          >
            <RotateCcw aria-hidden className="h-3.5 w-3.5" />
          </button>
        </div>
      ) : (
        <div className="mist-scroll max-h-[70vh] space-y-1.5 overflow-y-auto pr-1">
          {list.length === 0 ? (
            <p className="p-3 text-xs text-slate-500">No threads yet — start a conversation</p>
          ) : (
            list.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setActiveThread(t.id)}
                aria-current={activeId === t.id ? 'true' : undefined}
                className={cn(
                  'w-full p-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60',
                  activeId === t.id
                    ? 'rounded-xl border border-purple-400/40 bg-purple-400/10'
                    : 'mist-glass-soft hover:border-white/20'
                )}
              >
                <span className="block truncate text-sm text-slate-200">
                  {t.title || 'Untitled'}
                </span>
                <span className="mt-0.5 block font-mono text-[10px] text-slate-500">
                  {timeAgo(t.created_at)}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
