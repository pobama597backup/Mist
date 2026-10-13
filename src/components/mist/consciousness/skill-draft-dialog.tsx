'use client'

// M.I.S.T. — skill-draft-dialog: the save-as-skill teaching dialog.
//
// Phase 4-a · chat-panel split: the dialog JSX (name / trigger / steps form)
// extracted from the god-file one-to-one. The draft state and the save flow
// stay in the panel — this is the pure form surface.

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

export interface SkillDraft {
  msgId: string
  tool: string
  name: string
  trigger: string
  steps: string
}

export interface SkillDraftDialogProps {
  draft: SkillDraft | null
  /** Field edits flow straight back into the panel's draft state. */
  onDraftChange: (next: SkillDraft) => void
  onClose: () => void
  onSave: () => void
}

export function SkillDraftDialog({ draft, onDraftChange, onClose, onSave }: SkillDraftDialogProps) {
  return (
    <Dialog open={!!draft} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="border-white/10 bg-slate-900/95 backdrop-blur-xl sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-slate-100">Save as skill</DialogTitle>
          <DialogDescription className="text-slate-500">
            Teach M.I.S.T. to reuse this tool pattern later.
          </DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            onSave()
          }}
          className="space-y-3"
        >
          <div className="space-y-1.5">
            <label
              htmlFor="skill-name"
              className="font-mono text-[10px] uppercase tracking-widest text-slate-500"
            >
              name
            </label>
            <Input
              id="skill-name"
              value={draft?.name ?? ''}
              onChange={(e) => draft && onDraftChange({ ...draft, name: e.target.value })}
              className="border-white/10 bg-white/5 text-sm text-slate-100 focus-visible:ring-purple-400/60"
            />
          </div>
          <div className="space-y-1.5">
            <label
              htmlFor="skill-trigger"
              className="font-mono text-[10px] uppercase tracking-widest text-slate-500"
            >
              trigger
            </label>
            <Input
              id="skill-trigger"
              value={draft?.trigger ?? ''}
              onChange={(e) => draft && onDraftChange({ ...draft, trigger: e.target.value })}
              className="border-white/10 bg-white/5 text-sm text-slate-100 focus-visible:ring-purple-400/60"
            />
          </div>
          <div className="space-y-1.5">
            <label
              htmlFor="skill-steps"
              className="font-mono text-[10px] uppercase tracking-widest text-slate-500"
            >
              steps
            </label>
            <Textarea
              id="skill-steps"
              rows={4}
              value={draft?.steps ?? ''}
              onChange={(e) => draft && onDraftChange({ ...draft, steps: e.target.value })}
              className="min-h-20 border-white/10 bg-white/5 font-mono text-xs text-slate-200 focus-visible:ring-purple-400/60"
            />
          </div>
          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="ghost"
              onClick={onClose}
              className="rounded-lg text-slate-400 hover:bg-white/5 hover:text-slate-200 focus-visible:ring-purple-400/60"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="rounded-lg border border-purple-400/40 bg-purple-400/20 text-purple-100 hover:bg-purple-400/30 focus-visible:ring-purple-400/60"
            >
              Save skill
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
