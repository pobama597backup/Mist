'use client'

// M.I.S.T. — composer: the chat panel's input surface.
//
// Phase 4-a · chat-panel split: the composer region (input + send +
// hold-to-talk + deep-research toggle + the drag-resize grip) extracted from
// the god-file one-to-one — same auto-grow, same persisted drag height, same
// PTT button semantics. The panel owns the input VALUE (send logic and
// external compose events need it); everything visual lives here.

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from 'react'
import { motion } from 'framer-motion'
import { GripHorizontal, Mic, MicOff, Send, Telescope, Users } from 'lucide-react'
import type { MistPersona, ResearchDepth } from '@/lib/store'
import { cn } from '@/lib/utils'

const COMPOSER_MAX_H = 144 // ~6 rows (auto-grow cap — a dragged minimum raises it)

// Drag-resize grip bounds + persistence (v6 resizable composer).
const COMPOSER_H_MIN = 96
const COMPOSER_H_MAX = 340
const COMPOSER_H_DEFAULT = 96
const COMPOSER_H_STEP = 24
const COMPOSER_H_KEY = 'mist:composerHeight'

function clampComposerH(v: number): number {
  if (!Number.isFinite(v)) return COMPOSER_H_DEFAULT
  return Math.min(COMPOSER_H_MAX, Math.max(COMPOSER_H_MIN, Math.round(v)))
}

function saveComposerH(v: number) {
  try {
    window.localStorage.setItem(COMPOSER_H_KEY, JSON.stringify(v))
  } catch {
    /* storage unavailable — ignore */
  }
}

export interface ComposerProps {
  /** The input VALUE lives in the panel (send + external compose events). */
  input: string
  onInput: (v: string) => void
  textareaRef: RefObject<HTMLTextAreaElement | null>
  /** Fire-and-forget send with the current text. */
  onSend: (text: string) => void
  awaiting: boolean
  /** PTT recorder state (mic-controller lives in the panel). */
  recording: boolean
  micActiveRef: { current: boolean }
  onMicDown: () => void
  onMicUp: () => void
  persona: MistPersona
  researchMode: boolean
  onResearchMode: (b: boolean) => void
  researchDepth: ResearchDepth
  onResearchDepth: (d: ResearchDepth) => void
  reduced: boolean
}

export function Composer(props: ComposerProps) {
  const {
    input,
    onInput,
    textareaRef,
    onSend,
    awaiting,
    recording,
    micActiveRef,
    onMicDown,
    onMicUp,
    persona,
    researchMode,
    onResearchMode,
    researchDepth,
    onResearchDepth,
    reduced,
  } = props

  /** User-dragged minimum composer height (px) — auto-grow extends beyond it. */
  const [composerMinHeight, setComposerMinHeight] = useState(COMPOSER_H_DEFAULT)
  const [draggingComposer, setDraggingComposer] = useState(false)

  const dragStartYRef = useRef(0)
  const dragStartHRef = useRef(0)
  /** Latest composer height for the window pointerup safety net (fresh reads
   * without re-registering the listener on every drag pixel). */
  const composerHRef = useRef(COMPOSER_H_DEFAULT)

  useEffect(() => {
    composerHRef.current = composerMinHeight
  }, [composerMinHeight])

  // ---------------------------------------------------------------- auto-grow

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    // Auto-grow 1→6 rows, never below the user-dragged minimum (the inline
    // min-height enforces that floor visually) and never above a cap that the
    // dragged minimum may have raised.
    const cap = Math.max(COMPOSER_MAX_H, composerMinHeight)
    el.style.height = `${Math.min(el.scrollHeight, cap)}px`
    el.style.overflowY = el.scrollHeight > cap ? 'auto' : 'hidden'
  }, [input, composerMinHeight, textareaRef])

  // Restore the persisted composer height after mount (deferred a macrotask
  // so the effect body stays free of synchronous setState).
  useEffect(() => {
    const id = window.setTimeout(() => {
      try {
        const raw = window.localStorage.getItem(COMPOSER_H_KEY)
        if (raw === null) return
        const v = Number(JSON.parse(raw))
        if (Number.isFinite(v)) setComposerMinHeight(clampComposerH(v))
      } catch {
        /* ignore malformed storage */
      }
    }, 0)
    return () => window.clearTimeout(id)
  }, [])

  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    onSend(input)
  }

  const onComposerKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      onSend(input)
    }
  }

  // ------------------------------------------------- composer resize grip (v6)

  const onGripPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.preventDefault()
    dragStartYRef.current = e.clientY
    dragStartHRef.current = composerMinHeight
    setDraggingComposer(true)
    try {
      // Pointer capture keeps the drag anchored to the grip even when the
      // pointer leaves the element (no window listeners needed).
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* capture unsupported — drag still ends on pointerup */
    }
  }

  const onGripPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!draggingComposer) return
    // The grip sits below the box: dragging DOWN grows it.
    setComposerMinHeight(
      clampComposerH(dragStartHRef.current + (e.clientY - dragStartYRef.current))
    )
  }

  const onGripPointerEnd = (e: PointerEvent<HTMLDivElement>) => {
    if (!draggingComposer) return
    setDraggingComposer(false)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* already released */
    }
    saveComposerH(composerMinHeight)
  }

  // Safety net: if pointer capture is ever lost (synthetic events, alt-tab,
  // capture rejection), a window-level pointerup/pointercancel still ends the
  // drag so the accent line never sticks. Idempotent with the grip's own end
  // handler.
  useEffect(() => {
    if (!draggingComposer) return
    const onUp = () => {
      setDraggingComposer(false)
      saveComposerH(composerHRef.current)
    }
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [draggingComposer])

  const onGripDoubleClick = () => {
    setComposerMinHeight(COMPOSER_H_DEFAULT)
    saveComposerH(COMPOSER_H_DEFAULT)
  }

  const onGripKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null
    if (e.key === 'ArrowUp') next = composerMinHeight + COMPOSER_H_STEP
    else if (e.key === 'ArrowDown') next = composerMinHeight - COMPOSER_H_STEP
    else if (e.key === 'Home') next = COMPOSER_H_MIN
    else if (e.key === 'End') next = COMPOSER_H_MAX
    if (next === null) return
    e.preventDefault()
    const v = clampComposerH(next)
    setComposerMinHeight(v)
    saveComposerH(v)
  }

  // ---------------------------------------------------------------- render

  return (
    <form
      onSubmit={submit}
      className={cn('border-t border-white/10 p-4', draggingComposer && 'select-none')}
    >
      {/* swarm persona hint (v5) */}
      {persona === 'swarm' && (
        <p className="mb-2 flex items-center gap-1.5 font-mono text-[10px] text-purple-300/70">
          <Users aria-hidden className="h-3 w-3 shrink-0" />
          Swarm orchestrator — MIST coordinates parallel roles
        </p>
      )}

      {/* deep research controls (v5) */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={researchMode}
          aria-label="Deep research mode"
          onClick={() => onResearchMode(!researchMode)}
          className={cn(
            'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-fuchsia-400/60',
            researchMode
              ? 'border-fuchsia-400/60 bg-fuchsia-400/15 text-fuchsia-200 shadow-[0_0_18px_-4px_rgba(232,121,249,0.55)]'
              : 'border-white/10 bg-white/[0.03] text-slate-400 hover:border-fuchsia-400/30 hover:text-slate-200'
          )}
        >
          <Telescope
            aria-hidden
            className={cn('h-3.5 w-3.5 shrink-0', researchMode && !reduced && 'animate-mist-pulse-glow')}
          />
          Deep Research
        </button>
        {researchMode && (
          <div
            role="radiogroup"
            aria-label="Research depth"
            className="inline-flex items-center gap-1.5"
          >
            <span className="font-mono text-[10px] text-slate-500">depth</span>
            <div className="inline-flex overflow-hidden rounded-full border border-white/10 bg-white/[0.03]">
              {([1, 2] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  role="radio"
                  aria-checked={researchDepth === d}
                  aria-label={d === 1 ? 'Standard depth, two pages' : 'Deep depth, four pages'}
                  onClick={() => onResearchDepth(d)}
                  className={cn(
                    'px-2.5 py-1 font-mono text-[10px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-fuchsia-400/60',
                    researchDepth === d
                      ? 'bg-fuchsia-400/20 text-fuchsia-200'
                      : 'text-slate-500 hover:text-slate-300'
                  )}
                >
                  {d}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="flex items-end gap-2.5">
        {recording ? (
          <span
            aria-hidden
            className="mist-eq mb-3.5 shrink-0 text-rose-400"
            title="Recording"
          >
            <span /><span /><span /><span /><span />
          </span>
        ) : null}
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => onInput(e.target.value)}
          onKeyDown={onComposerKeyDown}
          rows={1}
          disabled={awaiting}
          placeholder="Speak your mind…"
          aria-label="Message M.I.S.T."
          style={{ minHeight: composerMinHeight }}
          className="mist-glass-soft w-full flex-1 resize-none bg-transparent px-3.5 py-2.5 text-[15px] text-slate-100 placeholder:text-slate-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60 disabled:cursor-not-allowed disabled:opacity-50"
        />

        <motion.button
          type="button"
          aria-label="Hold to talk"
          onPointerDown={(e) => {
            e.preventDefault()
            onMicDown()
          }}
          onPointerUp={() => onMicUp()}
          onPointerLeave={() => {
            if (micActiveRef.current) onMicUp()
          }}
          onKeyDown={(e) => {
            if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
              e.preventDefault()
              onMicDown()
            }
          }}
          onKeyUp={(e) => {
            if (e.key === ' ' || e.key === 'Enter') {
              e.preventDefault()
              onMicUp()
            }
          }}
          whileHover={reduced ? undefined : { scale: 1.05 }}
          whileTap={reduced ? undefined : { scale: 0.96 }}
          className={cn(
            'relative flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60',
            recording
              ? 'border border-rose-400/50 bg-rose-400/20 text-rose-300'
              : 'mist-glass-soft text-slate-300 hover:text-emerald-300'
          )}
        >
          {recording && (
            <span
              aria-hidden
              className="absolute inset-0 animate-mist-pulse-glow rounded-xl border-2 border-rose-400/40"
            />
          )}
          {recording ? (
            <MicOff aria-hidden className="h-4 w-4" />
          ) : (
            <Mic aria-hidden className="h-4 w-4" />
          )}
        </motion.button>

        <motion.button
          type="button"
          aria-label="Send message"
          onClick={() => onSend(input)}
          disabled={!input.trim() || awaiting}
          whileHover={reduced ? undefined : { scale: 1.05 }}
          whileTap={reduced ? undefined : { scale: 0.96 }}
          className={cn(
            'flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-xl border border-purple-400/40 bg-purple-400/20 text-purple-200 transition-all duration-200 hover:bg-purple-400/30 hover:shadow-[0_0_20px_-4px_rgba(192,132,252,0.6)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60 disabled:cursor-not-allowed disabled:opacity-40 disabled:shadow-none',
            awaiting && !reduced && 'animate-mist-ripple-ring'
          )}
        >
          <Send aria-hidden className="h-4 w-4" />
        </motion.button>
      </div>

      {/* drag-resize grip (v6) — drag to set the composer's minimum height;
          double-click resets; ArrowUp/Down adjust when keyboard-focused */}
      <div
        role="slider"
        tabIndex={0}
        aria-label="Drag to resize the message box"
        aria-orientation="vertical"
        aria-valuemin={COMPOSER_H_MIN}
        aria-valuemax={COMPOSER_H_MAX}
        aria-valuenow={Math.round(composerMinHeight)}
        onPointerDown={onGripPointerDown}
        onPointerMove={onGripPointerMove}
        onPointerUp={onGripPointerEnd}
        onPointerCancel={onGripPointerEnd}
        onDoubleClick={onGripDoubleClick}
        onKeyDown={onGripKeyDown}
        className={cn(
          'mx-auto mt-2 flex h-6 w-20 cursor-ns-resize touch-none items-center justify-center rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60',
          draggingComposer ? 'bg-purple-400/15' : 'hover:bg-white/5'
        )}
      >
        <GripHorizontal
          aria-hidden
          className={cn(
            'h-4 w-4 transition-colors',
            draggingComposer ? 'text-purple-300' : 'text-slate-600'
          )}
        />
      </div>
      {/* accent line — lit while dragging */}
      <div
        aria-hidden
        className={cn(
          '-mx-4 mt-1 h-0.5 rounded-full transition-colors duration-150',
          draggingComposer ? 'bg-purple-400/60' : 'bg-transparent'
        )}
      />
    </form>
  )
}
