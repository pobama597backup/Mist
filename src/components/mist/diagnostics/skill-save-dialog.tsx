'use client'

// SkillSaveDialog — shared editor for teaching M.I.S.T. a new skill.
// Used by the Tools tab (prefilled from a successful run, tool_chain locked)
// and the Skills tab (empty draft).

import { useEffect, useState } from 'react'
import { Loader2, Lock, Sparkles } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { mistApi } from '@/lib/mist-api'
import { toast } from 'sonner'

export interface SkillDraft {
  name: string
  trigger: string
  steps: string
  /** When provided the chain is locked (display-only) and saved verbatim. */
  tool_chain?: string[]
  notes?: string
}

export function SkillSaveDialog({
  open,
  onOpenChange,
  initial,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initial?: SkillDraft
  onSaved?: () => void
}) {
  const [name, setName] = useState('')
  const [trigger, setTrigger] = useState('')
  const [steps, setSteps] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)

  // Re-seed the form every time the dialog opens.
  useEffect(() => {
    if (open) {
      setName(initial?.name ?? '')
      setTrigger(initial?.trigger ?? '')
      setSteps(initial?.steps ?? '')
      setNotes(initial?.notes ?? '')
    }
  }, [open, initial])

  const canSave = name.trim().length > 0 && trigger.trim().length > 0 && !saving

  const handleSave = async () => {
    if (!canSave) return
    setSaving(true)
    try {
      await mistApi.skills.save({
        name: name.trim(),
        trigger: trigger.trim(),
        steps,
        tool_chain: initial?.tool_chain ?? [],
        notes,
      })
      toast.success('Skill saved — M.I.S.T. will recall it on similar triggers')
      onOpenChange(false)
      onSaved?.()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to save skill')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-white/10 bg-slate-950/95 backdrop-blur-2xl sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 font-mono text-sm tracking-widest text-slate-200">
            <Sparkles className="h-4 w-4 text-teal-300" aria-hidden="true" />
            TEACH A SKILL
          </DialogTitle>
          <DialogDescription className="font-mono text-[11px] text-slate-500">
            M.I.S.T. will recall this pattern when a similar trigger appears.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            handleSave()
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="skill-name" className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
              Name
            </Label>
            <Input
              id="skill-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. weather-check"
              className="h-9 border-white/10 bg-white/5 font-mono text-xs"
              maxLength={64}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="skill-trigger" className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
              Trigger
            </Label>
            <Input
              id="skill-trigger"
              value={trigger}
              onChange={(e) => setTrigger(e.target.value)}
              placeholder="when this phrase appears…"
              className="h-9 border-white/10 bg-white/5 font-mono text-xs"
              maxLength={200}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="skill-steps" className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
              Steps
            </Label>
            <Textarea
              id="skill-steps"
              value={steps}
              onChange={(e) => setSteps(e.target.value)}
              placeholder="Describe what to do, step by step…"
              className="h-24 border-white/10 bg-white/5 font-mono text-[11px]"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="skill-notes" className="font-mono text-[10px] uppercase tracking-widest text-slate-500">
              Notes <span className="normal-case text-slate-500">(optional)</span>
            </Label>
            <Input
              id="skill-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="anything worth remembering…"
              className="h-9 border-white/10 bg-white/5 font-mono text-xs"
              maxLength={200}
            />
          </div>

          {initial?.tool_chain && initial.tool_chain.length > 0 ? (
            <div className="space-y-1.5">
              <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-widest text-slate-500">
                <Lock className="h-3 w-3" aria-hidden="true" /> Tool chain (locked)
              </span>
              <div className="flex flex-wrap gap-1.5">
                {initial.tool_chain.map((t) => (
                  <span
                    key={t}
                    className="rounded-full border border-amber-300/20 bg-amber-300/10 px-2 py-0.5 font-mono text-[10px] text-amber-300/80"
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => onOpenChange(false)}
              className="font-mono text-xs text-slate-400 hover:text-slate-200"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={!canSave}
              className="bg-purple-400/90 font-mono text-xs text-slate-950 hover:bg-purple-300"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />}
              Save skill
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
