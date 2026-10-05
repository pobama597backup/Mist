'use client'

// M.I.S.T. — MistPowerPalette (oj-face-5, OpenJarvis UX port).
//
// The power palette — Ctrl+Shift+P (distinct from the navbar's Ctrl+K nav
// palette): three tabs of real surfaces —
//   Models  · serving lanes (store provider preference) + the Mist Core GLM
//             catalog (config path: MIST_CORE_TEXT_MODEL)
//   Tools   · the live tool registry (GET /api/mist/tools/list) grouped by
//             category, with param signatures
//   Actions · generate digest, check upstream oj-sync, open diagnostics
//             drawer views, run operators, search the knowledge base
//
// Desktop → CommandDialog; mobile (<768px) → bottom Sheet variant. Fuzzy
// search + keyboard nav come from cmdk; every async surface has honest
// loading skeletons and error states. All fetches are relative paths.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Activity,
  ArrowUpRight,
  Bot,
  Check,
  Cpu,
  Database,
  FileText,
  GitCompareArrows,
  Globe,
  Hammer,
  Search,
  Sparkles,
  Wrench,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '@/components/ui/command'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { useMistStore, type DrawerTab } from '@/lib/store'
import { useIsMobile } from '@/hooks/use-mobile'
import { mistApi } from '@/lib/mist-api'
import { PROVIDER_LABELS } from '@/lib/mist-constants'
import type { LlmStatus, ProviderId, ToolInfo } from '@/lib/types'
import {
  checkOjSync,
  generateDigest,
  listOperators,
  operatorAction,
  searchKnowledge,
  type OperatorItem,
} from '@/lib/oj/ui-api'
import { cn } from '@/lib/utils'

type PaletteTab = 'models' | 'tools' | 'actions'

const TABS: Array<{ id: PaletteTab; label: string; icon: typeof Cpu }> = [
  { id: 'models', label: 'Models', icon: Cpu },
  { id: 'tools', label: 'Tools', icon: Wrench },
  { id: 'actions', label: 'Actions', icon: Sparkles },
]

const PLACEHOLDER: Record<PaletteTab, string> = {
  models: 'Search lanes and core models…',
  tools: 'Search the tool registry…',
  actions: 'Search actions… (type 2+ chars to search knowledge)',
}

const DRAWER_VIEWS: Array<{ id: DrawerTab; label: string }> = [
  { id: 'system', label: 'System overview' },
  { id: 'tools', label: 'Tool registry' },
  { id: 'memory', label: 'Memory vault' },
  { id: 'skills', label: 'Skills' },
  { id: 'agents', label: 'Agents' },
  { id: 'evolve', label: 'Evolution proposals' },
  { id: 'automations', label: 'Automations' },
  { id: 'vault', label: 'Vault' },
]

// ---------------------------------------------------------------- actions

function usePaletteActions() {
  const setProvider = useMistStore((s) => s.setProvider)
  const openDrawer = useMistStore((s) => s.openDrawer)

  const chooseProvider = useCallback(
    (p: ProviderId) => {
      setProvider(p)
      toast.success(`Serving lane set to ${PROVIDER_LABELS[p] ?? p}`, {
        description: 'Rides along with every thought you send.',
      })
    },
    [setProvider]
  )

  const chooseCoreModel = useCallback(async (id: string, label: string) => {
    try {
      await mistApi.config.setEnv({ MIST_CORE_TEXT_MODEL: id }, true)
      toast.success(`Mist Core text model → ${label}`, {
        description: 'Saved to the config (same path as the Settings panel).',
      })
    } catch (e) {
      toast.error('Could not save core model', {
        description: e instanceof Error ? e.message : 'config unreachable',
      })
    }
  }, [])

  const doDigest = useCallback(() => {
    toast.promise(
      generateDigest().then((r) => {
        if (!r.ok) throw new Error(r.error)
        return r.data
      }),
      {
        loading: 'Collecting the state of her world…',
        success: (d) => ({
          message: d.headline,
          description: `${d.items.length} items · tone ${d.tone}${d.degraded ? ' · degraded' : ''}`,
        }),
        error: (e) => (e instanceof Error ? e.message : 'digest engine unreachable'),
      }
    )
  }, [])

  const doSyncCheck = useCallback(() => {
    toast.promise(
      checkOjSync().then((r) => {
        if (!r.ok) throw new Error(r.error)
        return r.data
      }),
      {
        loading: 'Pinging the OpenJarvis upstream…',
        success: (r) => ({
          message: r.changed ? 'Upstream moved — new HEAD detected' : 'Up to date',
          description: r.message,
        }),
        error: (e) => (e instanceof Error ? e.message : 'sync check unreachable'),
      }
    )
  }, [])

  const doRunOperator = useCallback((op: OperatorItem) => {
    const action = op.status === 'paused' ? 'resume' : 'run'
    toast.promise(
      operatorAction(op.slug, action).then((r) => {
        if (!r.ok) throw new Error(r.error)
        return r
      }),
      {
        loading: `${op.name} ${action === 'resume' ? 'resuming' : 'running'}…`,
        success: () => ({
          message: `${op.name} ${action === 'resume' ? 'resumed' : 'ran'} — ${op.humanSchedule}`,
        }),
        error: (e) => (e instanceof Error ? e.message : 'operator unreachable'),
      }
    )
  }, [])

  const doKnowledgeSearch = useCallback(async (query: string) => {
    const res = await searchKnowledge(query, 5)
    if (!res.ok) {
      toast.error('Knowledge search failed', { description: res.error })
      return
    }
    if (res.data.length === 0) {
      toast.info(`No knowledge matches “${query}”`, {
        description: 'Her store holds notes, vault pages and ingested docs — try other words.',
      })
      return
    }
    toast.success(`${res.data.length} chunk${res.data.length === 1 ? '' : 's'} matched “${query}”`, {
      description: res.data
        .slice(0, 3)
        .map((h) => `${h.title} (${h.source}, score ${h.score.toFixed(2)})`)
        .join('\n'),
    })
  }, [])

  return { chooseProvider, chooseCoreModel, doDigest, doSyncCheck, doRunOperator, doKnowledgeSearch, openDrawer }
}

// ---------------------------------------------------------------- tab body

function ModelsTab({
  status,
  current,
  onProvider,
  onCoreModel,
}: {
  status: LlmStatus | null
  current: ProviderId
  onProvider: (p: ProviderId) => void
  onCoreModel: (id: string, label: string) => void
}) {
  const providers = useMemo<ProviderId[]>(() => {
    if (!status) return []
    return status.available_providers?.length ? status.available_providers : ['auto']
  }, [status])

  const coreText = status?.core_models?.text ?? []

  return (
    <CommandList className="mist-scroll max-h-[min(60vh,26rem)]">
      <CommandEmpty>No lanes or models match.</CommandEmpty>
      {!status ? (
        <div className="space-y-2 p-3" aria-hidden>
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-11 w-full rounded-lg bg-white/5" />
          ))}
        </div>
      ) : (
        <>
          <CommandGroup heading="serving lane — every thought">
            {providers.map((p) => (
              <CommandItem key={p} value={`lane ${PROVIDER_LABELS[p] ?? p} ${p}`} onSelect={() => onProvider(p)}>
                <ArrowUpRight aria-hidden className="h-4 w-4 text-purple-300/70" />
                <span className="flex-1">{PROVIDER_LABELS[p] ?? p}</span>
                {current === p ? (
                  <CommandShortcut className="text-emerald-300/90">
                    <Check aria-hidden className="h-3.5 w-3.5" />
                    current
                  </CommandShortcut>
                ) : null}
              </CommandItem>
            ))}
          </CommandGroup>
          {coreText.length > 0 ? (
            <>
              <CommandSeparator />
              <CommandGroup heading="mist core catalog — set the text model">
                {coreText.map((m) => (
                  <CommandItem
                    key={m.id}
                    value={`core ${m.label} ${m.id} ${m.tier}`}
                    onSelect={() => void onCoreModel(m.id, m.label)}
                  >
                    <Cpu aria-hidden className="h-4 w-4 text-teal-300/70" />
                    <span className="flex-1 truncate">{m.label}</span>
                    <CommandShortcut>
                      <span className="font-mono text-[10px] text-slate-500">{m.tier}</span>
                      {m.live_verified ? (
                        <span className="ml-1.5 inline-flex items-center gap-0.5 font-mono text-[10px] text-emerald-300/90">
                          <Check aria-hidden className="h-3 w-3" />
                          live
                        </span>
                      ) : null}
                    </CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            </>
          ) : null}
        </>
      )}
    </CommandList>
  )
}

function ToolsTab({ tools }: { tools: ToolInfo[] | null }) {
  const byCategory = useMemo(() => {
    if (!tools) return []
    const map = new Map<string, ToolInfo[]>()
    for (const t of tools) {
      const list = map.get(t.category) ?? []
      list.push(t)
      map.set(t.category, list)
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [tools])

  return (
    <CommandList className="mist-scroll max-h-[min(60vh,26rem)]">
      <CommandEmpty>No tools match.</CommandEmpty>
      {!tools ? (
        <div className="space-y-2 p-3" aria-hidden>
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-11 w-full rounded-lg bg-white/5" />
          ))}
        </div>
      ) : (
        byCategory.map(([cat, list]) => (
          <CommandGroup key={cat} heading={`${cat} · ${list.length}`}>
            {list.map((t) => (
              <CommandItem
                key={t.name}
                value={`tool ${t.name} ${t.description} ${t.category}`}
                disabled={!t.implemented}
                onSelect={() =>
                  toast.info(`${t.name} · ${t.parameters.length} param${t.parameters.length === 1 ? '' : 's'}`, {
                    description:
                      t.parameters.length > 0
                        ? t.parameters.map((p) => `${p.name}${p.required ? '' : '?'}`).join(', ')
                        : t.description,
                  })
                }
              >
                <Hammer aria-hidden className={cn('h-4 w-4', t.implemented ? 'text-amber-300/70' : 'text-slate-600')} />
                <span className="flex-1 truncate font-mono text-[13px]">{t.name}</span>
                <CommandShortcut>
                  {t.implemented ? (
                    <span className="font-mono text-[10px] text-slate-500">{t.parameters.length}p</span>
                  ) : (
                    <span className="font-mono text-[10px] text-slate-600">stub</span>
                  )}
                </CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        ))
      )}
    </CommandList>
  )
}

function ActionsTab({
  operators,
  search,
  actions,
}: {
  operators: OperatorItem[] | null
  search: string
  actions: ReturnType<typeof usePaletteActions>
}) {
  const q = search.trim()
  return (
    <CommandList className="mist-scroll max-h-[min(60vh,26rem)]">
      <CommandEmpty>No actions match.</CommandEmpty>

      {/* live knowledge search — appears once there's a query */}
      {q.length >= 2 ? (
        <CommandGroup heading="knowledge">
          <CommandItem value={`search knowledge ${q}`} onSelect={() => void actions.doKnowledgeSearch(q)}>
            <Database aria-hidden className="h-4 w-4 text-teal-300/70" />
            <span className="flex-1 truncate">
              Search knowledge for <span className="text-teal-200">“{q.slice(0, 60)}”</span>
            </span>
            <CommandShortcut>
              <Search aria-hidden className="h-3.5 w-3.5" />
            </CommandShortcut>
          </CommandItem>
        </CommandGroup>
      ) : null}

      <CommandGroup heading="her systems">
        <CommandItem value="generate digest morning brief" onSelect={actions.doDigest}>
          <FileText aria-hidden className="h-4 w-4 text-fuchsia-300/70" />
          <span className="flex-1">Generate a digest</span>
          <CommandShortcut className="font-mono text-[10px]">now</CommandShortcut>
        </CommandItem>
        <CommandItem value="check upstream sync openjarvis upstream" onSelect={actions.doSyncCheck}>
          <GitCompareArrows aria-hidden className="h-4 w-4 text-purple-300/70" />
          <span className="flex-1">Check upstream sync</span>
          <CommandShortcut className="font-mono text-[10px]">OpenJarvis</CommandShortcut>
        </CommandItem>
      </CommandGroup>

      <CommandSeparator />
      <CommandGroup heading="diagnostics">
        {DRAWER_VIEWS.map((v) => (
          <CommandItem key={v.id} value={`open diagnostics ${v.label}`} onSelect={() => actions.openDrawer(v.id)}>
            <Activity aria-hidden className="h-4 w-4 text-slate-400" />
            <span className="flex-1">Diagnostics · {v.label}</span>
            <CommandShortcut>
              <ArrowUpRight aria-hidden className="h-3.5 w-3.5" />
            </CommandShortcut>
          </CommandItem>
        ))}
      </CommandGroup>

      {operators && operators.length > 0 ? (
        <>
          <CommandSeparator />
          <CommandGroup heading="operators">
            {operators.map((op) => (
              <CommandItem
                key={op.slug}
                value={`run operator ${op.name} ${op.slug} ${op.humanSchedule}`}
                onSelect={() => actions.doRunOperator(op)}
              >
                <Bot aria-hidden className={cn('h-4 w-4', op.status === 'paused' ? 'text-slate-500' : 'text-emerald-300/70')} />
                <span className="flex-1 truncate">
                  {op.status === 'paused' ? 'Resume' : 'Run'} {op.name}
                </span>
                <CommandShortcut className="font-mono text-[10px]">{op.humanSchedule}</CommandShortcut>
              </CommandItem>
            ))}
          </CommandGroup>
        </>
      ) : operators === null ? (
        <div className="space-y-2 p-3" aria-hidden>
          <Skeleton className="h-11 w-full rounded-lg bg-white/5" />
        </div>
      ) : null}
    </CommandList>
  )
}

// ---------------------------------------------------------------- shell

export function MistPowerPalette() {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<PaletteTab>('actions')
  const [search, setSearch] = useState('')
  const isMobile = useIsMobile()

  const provider = useMistStore((s) => s.provider)
  const actions = usePaletteActions()

  // lazy data — loaded once per open, per surface
  const [llmStatus, setLlmStatus] = useState<LlmStatus | null>(null)
  const [tools, setTools] = useState<ToolInfo[] | null>(null)
  const [operators, setOperators] = useState<OperatorItem[] | null>(null)
  const loadedRef = useRef<{ llm: boolean; tools: boolean; ops: boolean }>({ llm: false, tools: false, ops: false })

  // Ctrl+Shift+P / ⌘+Shift+P — distinct from the navbar's Ctrl+K
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyP') {
        e.preventDefault()
        setOpen((v) => !v)
      }
    }
    document.addEventListener('keydown', down)
    return () => document.removeEventListener('keydown', down)
  }, [])

  // load the active tab's data (once per session-open)
  useEffect(() => {
    if (!open) return
    if (tab === 'models' && !loadedRef.current.llm) {
      loadedRef.current.llm = true
      mistApi.llm
        .status()
        .then(setLlmStatus)
        .catch(() => setLlmStatus(null))
    }
    if (tab === 'tools' && !loadedRef.current.tools) {
      loadedRef.current.tools = true
      mistApi.tools
        .list()
        .then((t) => setTools(Array.isArray(t) ? t : []))
        .catch(() => setTools([]))
    }
    if (tab === 'actions' && !loadedRef.current.ops) {
      loadedRef.current.ops = true
      listOperators()
        .then((r) => setOperators(r.ok ? r.data : []))
        .catch(() => setOperators([]))
    }
  }, [open, tab])

  const switchTab = (t: PaletteTab) => {
    setTab(t)
    setSearch('')
  }

  const body = (
    <>
      {/* tab row — the palette's three surfaces */}
      <div role="tablist" aria-label="Palette surfaces" className="flex items-center gap-1 border-b border-white/10 px-2 py-2">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => switchTab(id)}
            className={cn(
              'flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg px-2 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60',
              tab === id
                ? 'bg-purple-400/15 text-purple-200'
                : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
            )}
          >
            <Icon aria-hidden className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      <Command shouldFilter>
        <CommandInput placeholder={PLACEHOLDER[tab]} value={search} onValueChange={setSearch} />
        {tab === 'models' ? (
          <ModelsTab status={llmStatus} current={provider} onProvider={actions.chooseProvider} onCoreModel={(id, label) => void actions.chooseCoreModel(id, label)} />
        ) : tab === 'tools' ? (
          <ToolsTab tools={tools} />
        ) : (
          <ActionsTab operators={operators} search={search} actions={actions} />
        )}
      </Command>

      {/* footer hint */}
      <p className="flex items-center justify-between gap-2 border-t border-white/10 px-3 py-1.5 font-mono text-[10px] text-slate-600">
        <span>↑↓ navigate · ↵ run · esc close</span>
        <span className="inline-flex items-center gap-1">
          <Globe aria-hidden className="h-3 w-3" />
          power palette
        </span>
      </p>
    </>
  )

  // mobile → bottom sheet; desktop → command dialog
  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="bottom"
          className="mx-auto flex h-[80vh] max-h-[80vh] flex-col gap-0 overflow-hidden rounded-t-3xl border-white/10 bg-slate-950/95 p-0 backdrop-blur-2xl [&_[cmdk-item]]:py-3"
        >
          <SheetHeader className="sr-only">
            <SheetTitle>M.I.S.T. power palette</SheetTitle>
            <SheetDescription>Models, tools and actions — search and run</SheetDescription>
          </SheetHeader>
          {body}
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="M.I.S.T. power palette"
      description="Models, tools and actions — search and run"
      className="border-white/10 bg-slate-950/95 backdrop-blur-2xl"
    >
      {body}
    </CommandDialog>
  )
}
