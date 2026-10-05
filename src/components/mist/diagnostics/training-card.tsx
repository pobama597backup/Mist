'use client'

// Training card — the curriculum distilled from the byte-by-byte study of
// OpenJarvis and Mark-LV (Oct 2026). Each mission trains one behavior the
// teachers have that Mist must internalize, with the pedagogy baked into the
// prompts themselves: teach-1-learn-10, no petting, no repeated mistakes.
// Two launch paths: COPY the prompt (paste into normal chat — the creator's
// ordered way) or RUN as an origin:'training' mission (the pedagogy rides
// the planner/actor prompts server-side).

import { useState } from 'react'
import { Copy, GraduationCap, Loader2, Play, ChevronDown, ChevronRight } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { TRAINING_MISSIONS, trainingPromptHeader, type TrainingMission } from '@/lib/training-missions'

function TrainingRow({ m }: { m: TrainingMission }) {
  const [open, setOpen] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [launched, setLaunched] = useState<string | null>(null)

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(trainingPromptHeader(m))
      toast.success('Prompt copied', {
        description: 'Paste it into the chat — she will take it from there.',
      })
    } catch {
      toast.error('Copy failed', { description: 'Select the text manually instead.' })
    }
  }

  const onRun = async () => {
    setLaunching(true)
    try {
      const res = await fetch('/api/mist/missions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          goal: m.prompt,
          title: `Training · ${m.title}`,
          origin: 'training',
          maxSteps: 14,
          maxMinutes: 12,
        }),
      })
      const data = (await res.json()) as { mission?: { id: string }; error?: string }
      if (!res.ok || !data.mission) throw new Error(data.error ?? 'launch failed')
      setLaunched(data.mission.id)
      toast.success(`Training mission launched — ${m.title}`, {
        description: 'Track it in the mission list below.',
      })
    } catch (err) {
      toast.error('Training launch failed', {
        description: err instanceof Error ? err.message : undefined,
      })
    } finally {
      setLaunching(false)
    }
  }

  return (
    <div className="rounded-xl border border-white/5 bg-white/[0.03] transition-colors hover:bg-white/[0.05]">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-start justify-between gap-3 p-3 text-left"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-xs font-medium text-slate-200">{m.title}</span>
            {launched ? (
              <span className="shrink-0 rounded border border-emerald-400/30 bg-emerald-400/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-emerald-300">
                running
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 line-clamp-1 text-[11px] text-slate-500">{m.trains}</p>
        </div>
        <span className="mt-0.5 shrink-0 text-slate-500">
          {open ? <ChevronDown aria-hidden className="h-3.5 w-3.5" /> : <ChevronRight aria-hidden className="h-3.5 w-3.5" />}
        </span>
      </button>
      {open ? (
        <div className="border-t border-white/5 px-3 pb-3 pt-2.5">
          <p className="font-mono text-[9px] uppercase tracking-wider text-slate-600">
            source · {m.source}
          </p>
          <p className="mt-2 max-h-36 overflow-y-auto mist-scroll whitespace-pre-wrap rounded-lg border border-white/5 bg-black/25 p-2.5 text-[11px] leading-relaxed text-slate-300">
            {m.prompt}
          </p>
          <div className="mt-2 flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => void onCopy()}
              className="h-7 gap-1.5 rounded-lg bg-purple-400/15 px-2.5 text-[10px] font-medium text-purple-200 hover:bg-purple-400/25"
            >
              <Copy aria-hidden className="h-3 w-3" />
              copy prompt
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void onRun()}
              disabled={launching || launched !== null}
              className="h-7 gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 text-[10px] font-medium text-slate-200 hover:bg-white/[0.09]"
            >
              {launching ? (
                <Loader2 aria-hidden className="h-3 w-3 animate-spin" />
              ) : (
                <Play aria-hidden className="h-3 w-3" />
              )}
              {launched ? 'launched' : 'run as mission'}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function TrainingCard() {
  return (
    <section aria-labelledby="training-heading" className="mist-glass rounded-xl p-4">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h3 id="training-heading" className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.25em] text-slate-500">
          <GraduationCap aria-hidden className="h-3.5 w-3.5 text-purple-300/80" />
          training grounds
        </h3>
        <span className="font-mono text-[9px] text-slate-600">
          {TRAINING_MISSIONS.length} drills · from the OJ + Mark-LV study
        </span>
      </div>
      <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
        The curriculum from studying OpenJarvis and Mark-LV byte by byte. Copy a prompt into chat (the
        creator&rsquo;s way) or launch it as a training mission — every drill ends by distilling a
        general rule: <span className="text-slate-400">teach one, understand ten</span>. No petting, no
        repeated mistakes.
      </p>
      <div className={cn('max-h-96 space-y-1.5 overflow-y-auto mist-scroll pr-1')}>
        {TRAINING_MISSIONS.map((m) => (
          <TrainingRow key={m.id} m={m} />
        ))}
      </div>
    </section>
  )
}
