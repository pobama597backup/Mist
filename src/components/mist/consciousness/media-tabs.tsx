'use client'

// M.I.S.T. — media-tabs: the per-message media attachment cards.
//
// Phase 4-a · chat-panel split: the "have you seen this?" attachment block
// (video/article cards with Watch here / jump to / open / save actions)
// extracted from the god-file one-to-one, together with its own handlers
// (open in the in-app browser + save to long-term memory). Self-contained —
// the card needs only its message row.

import { BookmarkPlus, ExternalLink, FileText, Play } from 'lucide-react'
import { toast } from 'sonner'
import { useCallback } from 'react'
import { mistApi } from '@/lib/mist-api'
import { useMistStore } from '@/lib/store'
import type { MediaAttachment } from '@/lib/types'
import { cn } from '@/lib/utils'
import type { LocalMessage } from './chat-panel'

function fmtSeek(seconds?: number): string {
  if (!seconds || seconds <= 0) return ''
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

// ---------------------------------------------------------------- handlers

/** "It opens a tab" — surface the attachment in the in-app browser. */
function useAttachmentActions() {
  const openAttachment = useCallback((a: MediaAttachment, seekTo?: number) => {
    useMistStore.getState().openBrowserTab({
      url: a.url,
      title: a.title,
      kind: a.type === 'video' ? 'video' : 'article',
      seekTo: seekTo ?? a.seek_to,
      note: a.note,
    })
  }, [])

  const saveAttachment = useCallback(async (a: MediaAttachment) => {
    try {
      let domain = a.url
      try {
        domain = new URL(a.url).hostname.replace(/^www\./, '')
      } catch {
        /* keep url */
      }
      await mistApi.memory.longterm.set(`saved ${domain}`, `${a.title} — ${a.url}`)
      toast.success('Saved to long-term memory')
    } catch {
      toast.error('Could not save link')
    }
  }, [])

  return { openAttachment, saveAttachment }
}

// ---------------------------------------------------------------- component

/** The attachments block for one assistant message (renders nothing when the
 *  message carries no media). */
export function MessageMedia({ message: m }: { message: LocalMessage }) {
  const { openAttachment, saveAttachment } = useAttachmentActions()
  if (!m.attachments || m.attachments.length === 0) return null
  return (
    <div className="mt-2 space-y-2">
      {m.attachments.map((a, i) => (
        <div
          key={`att-${m.id}-${i}`}
          className="mist-glass-soft rounded-xl border-purple-300/20 p-3"
        >
          <div className="flex items-start gap-3">
            <div
              aria-hidden
              className={cn(
                'mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border',
                a.type === 'video'
                  ? 'border-rose-300/30 bg-rose-300/10 text-rose-300'
                  : 'border-teal-300/30 bg-teal-300/10 text-teal-300'
              )}
            >
              {a.type === 'video' ? (
                <Play className="h-4 w-4" />
              ) : (
                <FileText className="h-4 w-4" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium text-slate-100">{a.title}</p>
              {a.note ? (
                <p className="mt-0.5 text-[11px] leading-snug text-slate-400">{a.note}</p>
              ) : null}
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => openAttachment(a)}
                  className="inline-flex items-center gap-1 rounded-md border border-purple-300/30 bg-purple-300/10 px-2 py-1 font-mono text-[10px] text-purple-200 transition-colors hover:bg-purple-300/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
                >
                  <Play aria-hidden className="h-3 w-3" />
                  {a.type === 'video' ? 'Watch here' : 'Read here'}
                </button>
                {a.type === 'video' && a.seek_to ? (
                  <button
                    type="button"
                    onClick={() => openAttachment(a, a.seek_to)}
                    className="inline-flex items-center gap-1 rounded-md border border-rose-300/30 bg-rose-300/10 px-2 py-1 font-mono text-[10px] text-rose-200 transition-colors hover:bg-rose-300/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rose-400/60"
                  >
                    jump to {fmtSeek(a.seek_to)}
                  </button>
                ) : null}
                <a
                  href={a.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1 font-mono text-[10px] text-slate-300 transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
                >
                  <ExternalLink aria-hidden className="h-3 w-3" />
                  open
                </a>
                <button
                  type="button"
                  onClick={() => void saveAttachment(a)}
                  className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/5 px-2 py-1 font-mono text-[10px] text-slate-300 transition-colors hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
                >
                  <BookmarkPlus aria-hidden className="h-3 w-3" />
                  save
                </button>
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  )
}
