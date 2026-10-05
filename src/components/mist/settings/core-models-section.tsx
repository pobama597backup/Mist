'use client'

// CoreModelsSection — Mist Core GLM model pickers (text vs vision/video, or one for both).
// Honest by design: the selection is REQUESTED on every core call, but the Z.ai gateway
// decides final routing — live chips always show what actually served the last call.

import { useEffect, useMemo, useState } from 'react'
import { Check, Link2, Loader2, Save, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SectionLabel } from '@/components/mist/diagnostics/shared'
import { mistApi } from '@/lib/mist-api'
import { cn } from '@/lib/utils'
import type { CoreModelOption, LlmStatus } from '@/lib/types'

const AUTO = 'auto'
const SAME_AS_TEXT = 'text'

function LiveChip({ requested, live, label }: { requested: string; live: string | null; label: string }) {
  if (!live) {
    return (
      <span className="font-mono text-[10px] text-slate-500">
        {label} serving: unknown until the next {label} call
      </span>
    )
  }
  const overridden = requested !== AUTO && requested !== SAME_AS_TEXT && requested !== live
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 font-mono text-[10px]',
        overridden ? 'text-amber-300/90' : 'text-emerald-300/80'
      )}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', overridden ? 'bg-amber-300/80' : 'bg-emerald-300/80')} aria-hidden="true" />
      {label} serving: {live}
      {overridden ? ' · gateway overrode your pick' : ''}
    </span>
  )
}

function ModelSelectItems({ models, kind }: { models: CoreModelOption[]; kind: 'text' | 'vision' }) {
  return (
    <>
      {models.map((m) => (
        <SelectItem key={m.id} value={m.id} className="font-mono text-xs text-slate-200">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate">{m.label}</span>
            <span className="shrink-0 text-[9px] uppercase tracking-wide text-slate-500">{m.tier}</span>
            {m.live_verified ? (
              <span className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-1.5 py-0.5 text-[9px] text-emerald-300">
                <Check className="h-2.5 w-2.5" aria-hidden="true" /> live
              </span>
            ) : null}
          </span>
        </SelectItem>
      ))}
      <SelectItem value="__none__" disabled className="font-mono text-[10px] text-slate-500">
        {kind === 'text' ? `${models.length} text models · newest → oldest` : `${models.length} vision models · newest → oldest`}
      </SelectItem>
    </>
  )
}

export function CoreModelsSection({ status, onSaved }: { status: LlmStatus | null; onSaved: () => void }) {
  const info = status?.core_models

  const [textSel, setTextSel] = useState<string>(AUTO)
  const [visionSel, setVisionSel] = useState<string>(AUTO)
  const [saving, setSaving] = useState(false)

  // sync from server whenever status refreshes (unless mid-edit)
  useEffect(() => {
    if (!info) return
    setTextSel(info.selected.text)
    setVisionSel(info.selected.vision)
  }, [info])

  const dirty = useMemo(
    () => Boolean(info && (textSel !== info.selected.text || visionSel !== info.selected.vision)),
    [info, textSel, visionSel]
  )

  const doSave = async () => {
    setSaving(true)
    try {
      await mistApi.config.setEnv(
        {
          MIST_CORE_TEXT_MODEL: textSel,
          MIST_CORE_VISION_MODEL: visionSel,
        },
        true
      )
      toast.success('Mist Core model selection saved')
      onSaved()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save model selection')
    } finally {
      setSaving(false)
    }
  }

  const visionRequested =
    visionSel === SAME_AS_TEXT ? (textSel === AUTO ? AUTO : textSel) : visionSel

  return (
    <div className="mist-glass p-5 sm:p-6">
      <SectionLabel
        right={
          info?.live.text ? (
            <span className="inline-flex items-center gap-1 font-mono text-[10px] text-emerald-300/70">
              <Sparkles className="h-3 w-3" aria-hidden="true" />
              {info.live.text}
            </span>
          ) : null
        }
      >
        mist core models
      </SectionLabel>
      <p className="mt-1.5 font-mono text-[10px] leading-relaxed text-slate-500">
        pick which GLM model Mist Core requests for text reasoning and for vision/video — or use one
        for both. Models are listed newest → oldest.
      </p>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="core-text-model" className="text-xs text-slate-300">
            Text &amp; reasoning
          </Label>
          <Select value={textSel} onValueChange={setTextSel}>
            <SelectTrigger
              id="core-text-model"
              aria-label="Text and reasoning model"
              className="h-9 w-full min-w-0 border-white/10 bg-white/5 font-mono text-xs text-slate-200"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-72 border-white/10 bg-slate-950/95 backdrop-blur-xl">
              <SelectItem value={AUTO} className="font-mono text-xs text-slate-200">
                <span className="flex items-center gap-2">
                  Auto
                  <span className="text-[9px] uppercase tracking-wide text-slate-500">gateway routing</span>
                </span>
              </SelectItem>
              <ModelSelectItems models={info?.text ?? []} kind="text" />
            </SelectContent>
          </Select>
          <LiveChip requested={textSel} live={info?.live.text ?? null} label="text" />
        </div>

        <div className="space-y-2">
          <Label htmlFor="core-vision-model" className="text-xs text-slate-300">
            Vision &amp; video
          </Label>
          <Select value={visionSel} onValueChange={setVisionSel}>
            <SelectTrigger
              id="core-vision-model"
              aria-label="Vision and video model"
              className="h-9 w-full min-w-0 border-white/10 bg-white/5 font-mono text-xs text-slate-200"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-72 border-white/10 bg-slate-950/95 backdrop-blur-xl">
              <SelectItem value={AUTO} className="font-mono text-xs text-slate-200">
                <span className="flex items-center gap-2">
                  Auto
                  <span className="text-[9px] uppercase tracking-wide text-slate-500">gateway routing</span>
                </span>
              </SelectItem>
              <SelectItem value={SAME_AS_TEXT} className="font-mono text-xs text-slate-200">
                <span className="flex items-center gap-2">
                  <Link2 className="h-3 w-3 text-purple-300" aria-hidden="true" />
                  Same as text
                  <span className="text-[9px] uppercase tracking-wide text-slate-500">one for both</span>
                </span>
              </SelectItem>
              <ModelSelectItems models={info?.vision ?? []} kind="vision" />
            </SelectContent>
          </Select>
          <LiveChip requested={visionRequested} live={info?.live.vision ?? null} label="vision" />
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-md font-mono text-[10px] leading-relaxed text-slate-500">
          The selection is requested on every core call, but the Z.ai gateway decides final routing —
          the live chips show the model that actually served your last request. That same name is
          stamped on every reply.
        </p>
        <Button
          type="button"
          size="sm"
          disabled={!dirty || saving}
          onClick={() => void doSave()}
          className="gap-1.5 bg-purple-400/90 font-mono text-[11px] text-slate-950 hover:bg-purple-300"
        >
          {saving ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <Save className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          Save selection
        </Button>
      </div>
    </div>
  )
}
