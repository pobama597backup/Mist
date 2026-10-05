'use client'

// SkillsTab — M.I.S.T.'s learned patterns. Also embedded in Settings.

import { useCallback, useEffect, useState } from 'react'
import { motion } from 'framer-motion'
import { Loader2, Plus, RotateCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { mistApi } from '@/lib/mist-api'
import { MonoBadge, SectionLabel, relTime } from './shared'
import { SkillSaveDialog } from './skill-save-dialog'
import type { SkillInfo } from '@/lib/types'

export function SkillsTab() {
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [deleting, setDeleting] = useState<SkillInfo | null>(null)
  const [removing, setRemoving] = useState(false)

  const load = useCallback(async () => {
    setLoadError(null)
    try {
      const list = await mistApi.skills.list()
      setSkills(list)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'skill registry unreachable')
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const removeSkill = async (skill: SkillInfo) => {
    setRemoving(true)
    try {
      await mistApi.skills.remove(skill.name)
      toast.success(`Skill "${skill.name}" removed from memory`)
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to remove skill')
    } finally {
      setRemoving(false)
      setDeleting(null)
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <SectionLabel
        right={
          <Button
            type="button"
            size="sm"
            onClick={() => setDialogOpen(true)}
            className="h-7 gap-1.5 bg-teal-300/90 px-2.5 font-mono text-[10px] text-slate-950 hover:bg-teal-200"
          >
            <Plus className="h-3 w-3" aria-hidden="true" /> New skill
          </Button>
        }
      >
        saved skills{skills ? ` · ${skills.length}` : ''}
      </SectionLabel>

      {skills === null && loadError === null ? (
        <div className="space-y-2.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="mist-glass-soft p-3">
              <Skeleton className="h-4 w-36 bg-white/5" />
              <Skeleton className="mt-2 h-3 w-2/3 bg-white/5" />
            </div>
          ))}
        </div>
      ) : loadError !== null && skills === null ? (
        <div className="mist-glass-soft flex flex-col items-start gap-3 p-4">
          <p className="font-mono text-[11px] text-rose-300/90">skill registry unreachable — {loadError}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void load()} className="gap-1.5 font-mono text-[11px]">
            <RotateCw className="h-3.5 w-3.5" aria-hidden="true" /> Retry
          </Button>
        </div>
      ) : skills != null && skills.length === 0 ? (
        <div className="mist-glass-soft p-4">
          <p className="text-xs leading-relaxed text-slate-400">
            No saved skills yet. Save one from a successful tool run in the Tools tab —{' '}
            <span className="text-teal-300">M.I.S.T. learns by doing.</span>
          </p>
        </div>
      ) : (
        <div className="min-w-0 space-y-2.5">
          {(skills ?? []).map((skill) => (
            <motion.div
              key={skill.name}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.2 }}
              whileHover={{ scale: 1.01 }}
              className="mist-glass-soft mist-glass-hover p-3"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-teal-300" title={skill.name}>
                  {skill.name}
                </span>
                <MonoBadge className="border-white/10 text-slate-400" title={`${skill.uses} uses`}>
                  ×{skill.uses}
                </MonoBadge>
                <button
                  type="button"
                  onClick={() => setDeleting(skill)}
                  aria-label={`Delete skill ${skill.name}`}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-rose-400/10 hover:text-rose-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
                >
                  <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
              </div>
              {skill.trigger ? (
                <p className="mt-1.5 min-w-0 truncate text-xs text-slate-300" title={skill.trigger}>
                  when: {skill.trigger}
                </p>
              ) : null}
              {skill.steps ? (
                <p className="mt-1 line-clamp-2 min-w-0 text-[11px] leading-relaxed text-slate-500">{skill.steps}</p>
              ) : null}
              {skill.tool_chain.length > 0 ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {skill.tool_chain.map((t) => (
                    <span
                      key={t}
                      className="rounded-full border border-amber-300/20 bg-amber-300/5 px-2 py-0.5 font-mono text-[10px] text-amber-300/80"
                    >
                      {t}
                    </span>
                  ))}
                </div>
              ) : null}
              <p className="mt-2 font-mono text-[10px] text-slate-600">learned {relTime(skill.created_at)}</p>
            </motion.div>
          ))}
        </div>
      )}

      {/* ---- delete confirmation ---- */}
      <AlertDialog open={deleting != null} onOpenChange={(o) => { if (!o) setDeleting(null) }}>
        <AlertDialogContent className="border-white/10 bg-slate-950/95 backdrop-blur-2xl sm:max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="font-mono text-sm tracking-widest text-rose-300">FORGET SKILL</AlertDialogTitle>
            <AlertDialogDescription className="font-mono text-[11px] leading-relaxed text-slate-400">
              Remove “{deleting?.name}” from M.I.S.T.&apos;s memory? This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2 sm:justify-end">
            <AlertDialogCancel className="font-mono text-xs">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const s = deleting
                if (s) void removeSkill(s)
              }}
              disabled={removing}
              className="bg-rose-400/90 font-mono text-xs text-slate-950 hover:bg-rose-300"
            >
              {removing ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
              Forget
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <SkillSaveDialog open={dialogOpen} onOpenChange={setDialogOpen} onSaved={load} />
    </div>
  )
}
