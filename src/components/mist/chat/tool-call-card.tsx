'use client'

// M.I.S.T. — ToolCallCard (oj-face-5, OpenJarvis UX port).
//
// Structured tool-call/result cards for chat messages that carry tool
// activity. HONESTY CONTRACT: chat messages today persist only
// `tools_used` (bare tool NAMES) in UnifiedLlmResponse + Message.meta — no
// structured calls with args/results/durations. So this component renders
// NOTHING unless it is handed real structured records:
//
//   - message-level mount reads `calls` from the (future) message meta —
//     absent today → returns null, never invents data;
//   - the XRayFooter trace timeline reuses this card with REAL records
//     parsed from spine TraceSteps (tool_call steps carry the full
//     {tool, args} input + result output + duration).

import { useState } from 'react'
import { AlertTriangle, Check, ChevronDown, Clock, Wrench } from 'lucide-react'
import type { TraceStep } from '@/lib/oj/ui-api'
import { cn } from '@/lib/utils'

/** One structured tool call record — the shape a message meta or trace step provides. */
export interface ToolCallRecord {
  name: string
  args?: unknown
  ok?: boolean
  error?: string
  durationMs?: number
  output?: unknown
}

/** Character cap before the inline truncation kicks in (expandable past it). */
const ARGS_PREVIEW = 160
const OUTPUT_PREVIEW = 220

function previewOf(value: unknown, cap: number): { text: string; truncated: boolean } {
  let text: string
  if (typeof value === 'string') text = value
  else {
    try {
      text = JSON.stringify(value, null, 2)
    } catch {
      text = String(value)
    }
  }
  if (text.length > cap) return { text: text.slice(0, cap), truncated: true }
  return { text, truncated: false }
}

/** Parse a spine tool_call TraceStep into a ToolCallRecord (input/output are JSON strings). */
export function traceStepToToolCall(step: TraceStep): ToolCallRecord {
  let args: unknown
  let name = step.name
  let output: unknown
  let error: string | undefined
  try {
    const parsed = JSON.parse(step.input) as { tool?: string; args?: unknown }
    if (parsed && typeof parsed === 'object') {
      if (typeof parsed.tool === 'string' && parsed.tool) name = parsed.tool
      args = parsed.args
    }
  } catch {
    /* input not JSON — keep the step name */
  }
  try {
    const parsed = JSON.parse(step.output) as { output?: unknown; error?: unknown }
    if (parsed && typeof parsed === 'object') {
      if (parsed.error !== undefined && parsed.error !== null) {
        error = typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error)
      } else if (parsed.output !== undefined) {
        output = parsed.output
      }
    } else {
      output = step.output
    }
  } catch {
    output = step.output
  }
  return { name, args, ok: step.ok, error, durationMs: step.durationMs, output }
}

/** A single tool-call card — name, args (expandable), ok/error, duration. */
function ToolCallRow({ call }: { call: ToolCallRecord }) {
  const [expanded, setExpanded] = useState(false)
  const ok = call.ok !== false
  const args = previewOf(call.args ?? null, ARGS_PREVIEW)
  const output = previewOf(call.output ?? null, OUTPUT_PREVIEW)
  const hasBody = (call.args !== undefined && call.args !== null) || call.output !== undefined || call.error !== undefined

  return (
    <div
      className={cn(
        'rounded-xl border px-2.5 py-2',
        ok ? 'border-amber-300/20 bg-amber-300/[0.04]' : 'border-rose-400/30 bg-rose-400/[0.06]'
      )}
    >
      <button
        type="button"
        onClick={() => hasBody && setExpanded((v) => !v)}
        aria-expanded={hasBody ? expanded : undefined}
        className={cn(
          'flex w-full items-center gap-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60',
          hasBody ? 'cursor-pointer rounded-lg' : 'cursor-default'
        )}
      >
        <span
          aria-hidden
          className={cn(
            'flex h-5 w-5 shrink-0 items-center justify-center rounded-md border',
            ok ? 'border-amber-300/30 bg-amber-300/10 text-amber-300' : 'border-rose-400/40 bg-rose-400/10 text-rose-300'
          )}
        >
          <Wrench className="h-3 w-3" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="font-mono text-[11px] text-amber-200/90">{call.name}</span>
          {args.text && !expanded ? (
            <span className="ml-2 truncate font-mono text-[10px] text-slate-500">{args.text.replace(/\s+/g, ' ')}</span>
          ) : null}
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {typeof call.durationMs === 'number' ? (
            <span className="inline-flex items-center gap-0.5 font-mono text-[10px] text-slate-500">
              <Clock aria-hidden className="h-3 w-3" />
              {call.durationMs < 1000 ? `${Math.round(call.durationMs)}ms` : `${(call.durationMs / 1000).toFixed(1)}s`}
            </span>
          ) : null}
          <span
            aria-label={ok ? 'succeeded' : 'failed'}
            className={cn('flex h-4 w-4 items-center justify-center', ok ? 'text-emerald-400' : 'text-rose-400')}
          >
            {ok ? <Check aria-hidden className="h-3.5 w-3.5" /> : <AlertTriangle aria-hidden className="h-3.5 w-3.5" />}
          </span>
          {hasBody ? (
            <ChevronDown
              aria-hidden
              className={cn('h-3.5 w-3.5 text-slate-500 transition-transform duration-200', expanded && 'rotate-180')}
            />
          ) : null}
        </span>
      </button>

      {expanded ? (
        <div className="mist-scroll mt-2 space-y-2 overflow-y-auto text-[11px]">
          {args.text ? (
            <div>
              <p className="font-mono text-[9px] uppercase tracking-widest text-slate-500">args</p>
              <pre className="mt-0.5 whitespace-pre-wrap break-all font-mono text-[10.5px] leading-relaxed text-slate-300">
                {args.text}
                {args.truncated ? <span className="text-slate-600"> …</span> : null}
              </pre>
            </div>
          ) : null}
          {call.error ? (
            <div>
              <p className="font-mono text-[9px] uppercase tracking-widest text-rose-300/80">error</p>
              <pre className="mt-0.5 whitespace-pre-wrap break-all font-mono text-[10.5px] leading-relaxed text-rose-300/90">
                {call.error}
              </pre>
            </div>
          ) : output.text ? (
            <div>
              <p className="font-mono text-[9px] uppercase tracking-widest text-slate-500">
                {ok ? 'result' : 'output'}
              </p>
              <pre className="mt-0.5 whitespace-pre-wrap break-all font-mono text-[10.5px] leading-relaxed text-slate-300">
                {output.text}
                {output.truncated ? <span className="text-slate-600"> …</span> : null}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Renders the tool-call cards for a message. HONEST: returns null when there
 * are no structured calls — bare `tools_used` name chips (rendered by the
 * chat panel itself) stay the only tool tell until message meta carries
 * structured records.
 */
export function ToolCallCard({ calls }: { calls?: ToolCallRecord[] | null }) {
  if (!calls || !Array.isArray(calls) || calls.length === 0) return null
  const valid = calls.filter((c) => c && typeof c.name === 'string' && c.name)
  if (valid.length === 0) return null
  return (
    <div className="mt-2 space-y-1.5" role="list" aria-label="Tool calls">
      {valid.map((c, i) => (
        <div role="listitem" key={`${c.name}-${i}`}>
          <ToolCallRow call={c} />
        </div>
      ))}
    </div>
  )
}
