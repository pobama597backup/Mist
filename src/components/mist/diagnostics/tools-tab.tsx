'use client'

// ToolsTab — the OmniRoute console: browse every tool by category, inspect
// parameters, craft JSON args and execute live (write tools gated behind an
// explicit confirmation). Successful runs can be taught back as skills.

import { useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { ChevronRight, GraduationCap, Loader2, Play, RotateCw, Search } from 'lucide-react'
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
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { mistApi } from '@/lib/mist-api'
import { cn } from '@/lib/utils'
import { MonoBadge } from './shared'
import { SkillSaveDialog, type SkillDraft } from './skill-save-dialog'
import type { ToolCategory, ToolExecuteResult, ToolInfo } from '@/lib/types'

interface RunState {
  running: boolean
  result: ToolExecuteResult | null
  error: string | null
}

type Filter = 'all' | ToolCategory

function defaultArgsJson(tool: ToolInfo): string {
  const obj: Record<string, unknown> = {}
  for (const p of tool.parameters) obj[p.name] = p.default ?? ''
  return JSON.stringify(obj, null, 2)
}

function paramsHint(tool: ToolInfo): string {
  if (tool.parameters.length === 0) return 'params: (none)'
  const parts = tool.parameters.map(
    (p) => `${p.name}:${p.type}${p.default !== undefined ? `=${p.default}` : ''}`
  )
  return `params: ${parts.join(', ')}`
}

function toolStatus(tool: ToolInfo): { label: string; cls: string } {
  if (!tool.implemented) {
    return { label: 'stub', cls: 'border-amber-300/30 bg-amber-300/10 text-amber-200' }
  }
  if (tool.category === 'omniroute' && tool.available === false) {
    return { label: 'unavailable', cls: 'border-white/10 bg-white/5 text-slate-500' }
  }
  if (tool.write) {
    return { label: 'write·confirm', cls: 'border-rose-400/30 bg-rose-400/10 text-rose-300' }
  }
  return { label: 'live', cls: 'border-emerald-400/30 bg-emerald-400/10 text-emerald-300' }
}

export function ToolsTab() {
  const [tools, setTools] = useState<ToolInfo[] | null>(null)
  const [categories, setCategories] = useState<ToolCategory[]>([])
  const [loadError, setLoadError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [search, setSearch] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [argsMap, setArgsMap] = useState<Record<string, string>>({})
  const [runs, setRuns] = useState<Record<string, RunState>>({})
  const [confirmTool, setConfirmTool] = useState<ToolInfo | null>(null)
  const [skillDraft, setSkillDraft] = useState<SkillDraft | null>(null)
  const [skillDialogOpen, setSkillDialogOpen] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let alive = true
    const run = async () => {
      try {
        const [list, cats] = await Promise.all([mistApi.tools.list(), mistApi.tools.categories()])
        if (!alive) return
        setTools(list)
        setCategories(Array.isArray(cats) ? cats : [])
        setLoadError(null)
      } catch (e) {
        if (alive) setLoadError(e instanceof Error ? e.message : 'Failed to load tools')
      }
    }
    void run()
    return () => {
      alive = false
    }
  }, [reloadKey])

  const visible = useMemo(() => {
    if (!tools) return []
    const q = search.trim().toLowerCase()
    return tools.filter(
      (t) =>
        (filter === 'all' || t.category === filter) &&
        (q === '' || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q))
    )
  }, [tools, filter, search])

  const chips: Filter[] = useMemo(() => {
    if (categories.length > 0) return ['all', ...categories]
    const derived = new Set<ToolCategory>()
    for (const t of tools ?? []) derived.add(t.category)
    return ['all', ...derived]
  }, [categories, tools])

  const argsFor = (tool: ToolInfo) => argsMap[tool.name] ?? defaultArgsJson(tool)

  const setArgs = (tool: ToolInfo, value: string) =>
    setArgsMap((m) => ({ ...m, [tool.name]: value }))

  const execute = async (tool: ToolInfo, confirmed: boolean) => {
    const args = JSON.parse(argsFor(tool)) as Record<string, unknown>
    setRuns((r) => ({ ...r, [tool.name]: { running: true, result: null, error: null } }))
    try {
      const res = await mistApi.tools.execute(tool.name, args, confirmed)
      setRuns((r) => ({ ...r, [tool.name]: { running: false, result: res, error: null } }))
      if (!res.success) toast.error(res.error ?? `${tool.name} failed`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'execution failed'
      setRuns((r) => ({ ...r, [tool.name]: { running: false, result: null, error: msg } }))
      toast.error(msg)
    }
  }

  const onRun = (tool: ToolInfo) => {
    try {
      JSON.parse(argsFor(tool))
    } catch {
      toast.error('Invalid JSON args')
      return
    }
    if (tool.write) {
      setConfirmTool(tool)
      return
    }
    void execute(tool, false)
  }

  const openSkillDialog = (tool: ToolInfo) => {
    setSkillDraft({
      name: tool.name,
      trigger: tool.name,
      steps: `Run ${tool.name} with ${argsFor(tool)}`,
      tool_chain: [tool.name],
    })
    setSkillDialogOpen(true)
  }

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {/* ---- filter row ---- */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter tools by category">
          {chips.map((c) => {
            const active = filter === c
            return (
              <button
                key={c}
                type="button"
                aria-pressed={active}
                onClick={() => setFilter(c)}
                className={cn(
                  'rounded-full border px-2 py-1 font-mono text-[10px] uppercase tracking-wide transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60',
                  active
                    ? 'border-purple-400/50 bg-purple-400/10 text-purple-200'
                    : 'border-white/10 text-slate-400 hover:border-white/25 hover:text-slate-300'
                )}
              >
                {c}
              </button>
            )
          })}
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-500" aria-hidden="true" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="search tools…"
            aria-label="Search tools"
            className="h-8 border-white/10 bg-white/5 pl-8 font-mono text-xs text-slate-200 placeholder:text-slate-500"
          />
        </div>
      </div>

      {/* ---- list ---- */}
      {tools === null && loadError === null ? (
        <div className="space-y-2.5">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="mist-glass-soft p-3">
              <Skeleton className="h-4 w-40 bg-white/5" />
              <Skeleton className="mt-2 h-3 w-3/4 bg-white/5" />
            </div>
          ))}
        </div>
      ) : loadError !== null && tools === null ? (
        <div className="mist-glass-soft flex flex-col items-start gap-3 p-4">
          <p className="font-mono text-[11px] text-rose-300/90">tools unavailable — {loadError}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => { setLoadError(null); setReloadKey((k) => k + 1) }} className="gap-1.5 font-mono text-[11px]">
            <RotateCw className="h-3.5 w-3.5" aria-hidden="true" /> Retry
          </Button>
        </div>
      ) : (
        <div className="max-h-[62vh] min-w-0 space-y-2.5 overflow-y-auto mist-scroll pr-1">
          {visible.length === 0 ? (
            <p className="py-6 text-center font-mono text-[11px] text-slate-500">no tools match this filter</p>
          ) : (
            visible.map((tool) => {
              const status = toolStatus(tool)
              const run = runs[tool.name]
              const isOpen = expanded === tool.name
              const failed = (run?.error != null) || run?.result?.success === false
              return (
                <motion.div
                  key={tool.name}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.2 }}
                  whileHover={{ scale: 1.01 }}
                  className="mist-glass-soft mist-glass-hover min-w-0 p-3"
                >
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : tool.name)}
                    aria-expanded={isOpen}
                    className="flex w-full items-start gap-2 rounded-xl text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-1.5">
                        <span className="font-mono text-xs text-emerald-300">{tool.name}</span>
                        <MonoBadge className="border-white/10 text-slate-500">{tool.category}</MonoBadge>
                        <MonoBadge className={status.cls}>{status.label}</MonoBadge>
                      </span>
                      <span className="mt-1 block text-xs leading-relaxed text-slate-400">{tool.description}</span>
                    </span>
                    <ExpandChevron open={isOpen} />
                  </button>

                  {isOpen ? (
                    <div className="mt-3 animate-mist-fade-in space-y-2 border-t border-white/5 pt-3">
                      {!tool.implemented ? (
                        <p className="font-mono text-[10px] text-amber-300/80">
                          stub — not implemented yet; running returns a placeholder response.
                        </p>
                      ) : null}
                      {tool.write ? (
                        <p className="font-mono text-[10px] text-rose-300/80">
                          write tool — execution requires explicit confirmation.
                        </p>
                      ) : null}
                      <p className="break-all font-mono text-[10px] text-slate-500">{paramsHint(tool)}</p>
                      <Textarea
                        value={argsFor(tool)}
                        onChange={(e) => setArgs(tool, e.target.value)}
                        aria-label={`Arguments for ${tool.name}`}
                        spellCheck={false}
                        className="h-24 min-w-0 resize-none border-white/5 bg-white/[0.03] font-mono text-[11px] text-slate-300"
                      />
                      <div className="flex flex-wrap items-center gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => onRun(tool)}
                          disabled={run?.running}
                          className="gap-1.5 border-emerald-400/25 bg-emerald-400/10 font-mono text-[11px] text-emerald-300 hover:border-emerald-400/40 hover:bg-emerald-400/15 hover:text-emerald-200"
                        >
                          {run?.running ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                          ) : (
                            <Play className="h-3.5 w-3.5" aria-hidden="true" />
                          )}
                          Run
                        </Button>
                        <span className="font-mono text-[10px] text-slate-500">POST /api/mist/tools/execute</span>
                      </div>

                      {run && (run.result != null || run.error != null) ? (
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono text-[10px] uppercase tracking-widest text-slate-500">result</span>
                            {run.result?.duration_ms != null ? (
                              <MonoBadge className="border-white/10 text-slate-500">{run.result.duration_ms}ms</MonoBadge>
                            ) : null}
                          </div>
                          <pre
                            className={cn(
                              'max-h-44 min-w-0 overflow-auto mist-scroll whitespace-pre-wrap break-all rounded-lg border p-3 font-mono text-[11px]',
                              failed
                                ? 'border-rose-400/30 bg-rose-400/[0.03] text-rose-300'
                                : 'border-emerald-400/20 bg-emerald-400/[0.03] text-slate-300'
                            )}
                          >
                            {run.error ?? JSON.stringify(run.result, null, 2)}
                          </pre>
                          {run.result?.success && run.result.suggest_skill ? (
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              onClick={() => openSkillDialog(tool)}
                              className="gap-1.5 border-teal-300/25 bg-teal-300/10 font-mono text-[11px] text-teal-300 hover:border-teal-300/40 hover:bg-teal-300/15 hover:text-teal-200"
                            >
                              <GraduationCap className="h-3.5 w-3.5" aria-hidden="true" />
                              Save as skill
                            </Button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </motion.div>
              )
            })
          )}
        </div>
      )}

      {/* ---- write-tool confirmation ---- */}
      <AlertDialog open={confirmTool != null} onOpenChange={(o) => { if (!o) setConfirmTool(null) }}>
        <AlertDialogContent className="border-white/10 bg-slate-950/95 backdrop-blur-2xl sm:max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle className="font-mono text-sm tracking-widest text-rose-300">
              WRITE TOOL — CONFIRM
            </AlertDialogTitle>
            <AlertDialogDescription className="font-mono text-[11px] leading-relaxed text-slate-400">
              This OmniRoute tool modifies the gateway. Execute anyway?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="gap-2 sm:justify-end">
            <AlertDialogCancel className="font-mono text-xs">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                const t = confirmTool
                setConfirmTool(null)
                if (t) void execute(t, true)
              }}
              className="bg-rose-400/90 font-mono text-xs text-slate-950 hover:bg-rose-300"
            >
              Confirm
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ---- teach-back skill dialog ---- */}
      <SkillSaveDialog
        open={skillDialogOpen}
        onOpenChange={setSkillDialogOpen}
        initial={skillDraft ?? undefined}
        onSaved={() => setSkillDraft(null)}
      />
    </div>
  )
}

function ExpandChevron({ open }: { open: boolean }) {
  return (
    <ChevronRight
      aria-hidden="true"
      className={cn('mt-0.5 h-4 w-4 shrink-0 text-slate-500 transition-transform duration-200', open && 'rotate-90')}
    />
  )
}
