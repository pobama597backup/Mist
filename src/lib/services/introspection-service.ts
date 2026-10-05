// M.I.S.T. introspection service — the SELF-DOCTOR (self-model v1.0).
//
// The creator's directive: "I want her to catch ALL these shortcomings and
// more and fix them." This is the organ that does exactly that: a catalog of
// probes that audit her own body and mind on a schedule (heartbeat hook) and
// on demand (chat tool / Diagnostics UI / API), a classifier that routes every
// finding to the right repair lane, and a repair loop that fixes what is safe
// to fix directly, pushes code-level fixes through her own 4-gate evolution
// engine, and escalates what only the creator can resolve into alerts.
//
// Design laws:
//   - a probe NEVER throws and NEVER blocks another probe (allSettled)
//   - every network/IO call is timeout-bounded
//   - findings are fingerprinted and deduped (6h) so she doesn't nag; the
//     third consecutive sighting of the same fingerprint escalates severity
//   - the live tree is only ever touched through applyProposal's staged gates
//   - everything is logged to the autonomy ledger; fail-class events alert
//     the creator through the normal ⚠️ path

import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { db } from '@/lib/db'
import { recordActivity } from './activity-service'
import { logAutonomyEvent } from './autonomy-service'
import { raiseSystemAlert } from './heartbeat-service'
import { getLlmStatus } from './llm-service'
import { listTools, findTool, executeTool } from './tools-service'
import { upsertFact, listFacts } from './memory-service'
import { recallDreams } from './dream-service'
import {
  getEvolutionStats,
  applyProposal,
  draftFixProposal,
} from './evolution-service'
import { SELF_MODEL_UPDATED_AT, selfModelManifest } from './self-model'

// ---------- types ----------

export type ProbeStatus = 'pass' | 'warn' | 'fail'

export type RepairClass = 'auto' | 'evolution' | 'creator' | 'none'

export interface Finding {
  /** Stable identity of this shortcoming (area + title hash). */
  fingerprint: string
  severity: 'warn' | 'fail'
  area: string
  title: string
  detail: string
  repair_class: RepairClass
  /** Machine instruction for the repair lane. */
  repair_hint: string
}

export interface ProbeResult {
  id: string
  status: ProbeStatus
  ms: number
  findings: Finding[]
  note?: string
}

export interface IntrospectionReport {
  ran_at: string
  source: 'manual' | 'heartbeat' | 'chat'
  duration_ms: number
  probes: ProbeResult[]
  findings: Finding[]
  /** Deduped findings actually actioned this run. */
  new_findings: Finding[]
  repairs: Array<{ finding: string; lane: RepairClass; outcome: string }>
  summary: string
  all_green: boolean
}

interface IntrospectionState {
  last_run_at: string | null
  last_report: IntrospectionReport | null
  /** fingerprint → { last_seen, count } */
  seen: Record<string, { last_seen: string; count: number }>
}

const STATE_FILE = path.join(process.cwd(), 'db', 'introspection-state.json')
const DEDUP_MS = 6 * 60 * 60 * 1000
const ESCALATE_AFTER = 3
const FETCH_TIMEOUT_MS = 8_000

function hashFingerprint(area: string, title: string): string {
  const s = `${area}::${title}`
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return `f${(h >>> 0).toString(36)}`
}

function finding(
  severity: Finding['severity'],
  area: string,
  title: string,
  detail: string,
  repair_class: RepairClass,
  repair_hint: string
): Finding {
  return { fingerprint: hashFingerprint(area, title), severity, area, title, detail, repair_class, repair_hint }
}

async function fetchWithTimeout(url: string, ms = FETCH_TIMEOUT_MS): Promise<Response> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), ms)
  try {
    return await fetch(url, { signal: ctl.signal, cache: 'no-store' })
  } finally {
    clearTimeout(t)
  }
}

/** Run a probe body safely — a crash becomes a fail-class finding about the probe itself. */
async function guarded(id: string, body: () => Promise<ProbeResult>): Promise<ProbeResult> {
  const t0 = Date.now()
  try {
    const res = await body()
    return { ...res, ms: Date.now() - t0 }
  } catch (err) {
    return {
      id,
      status: 'fail',
      ms: Date.now() - t0,
      findings: [
        finding(
          'fail',
          'introspection',
          `probe ${id} crashed`,
          `The probe itself threw: ${err instanceof Error ? err.message : 'unknown error'}`,
          'evolution',
          `fix probe ${id} so it reports instead of throwing`
        ),
      ],
    }
  }
}

// ---------- state ----------

async function readState(): Promise<IntrospectionState> {
  try {
    const raw = await fs.readFile(STATE_FILE, 'utf-8')
    const parsed = JSON.parse(raw) as Partial<IntrospectionState>
    return {
      last_run_at: parsed.last_run_at ?? null,
      last_report: parsed.last_report ?? null,
      seen: parsed.seen ?? {},
    }
  } catch {
    return { last_run_at: null, last_report: null, seen: {} }
  }
}

async function writeState(state: IntrospectionState): Promise<void> {
  try {
    await fs.mkdir(path.dirname(STATE_FILE), { recursive: true })
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8')
  } catch {
    // best-effort
  }
}

const reportGlobal = globalThis as unknown as {
  __mistIntrospection?: { report: IntrospectionReport | null }
}

export function getLastIntrospection(): IntrospectionReport | null {
  return reportGlobal.__mistIntrospection?.report ?? null
}

// ---------- probes ----------

/** Provider cascade health — the minds she thinks with. */
async function probeProviders(): Promise<ProbeResult> {
  const findings: Finding[] = []
  let status: ProbeStatus = 'pass'
  try {
    const llm = getLlmStatus()
    const configured = llm.providers_detail.filter((p) => p.id !== 'auto' && p.available)
    const note = `${configured.length} provider(s) configured: ${configured.map((p) => p.id).join(', ') || 'core only'}`
    if (!llm.configured && configured.length === 0) {
      findings.push(
        finding(
          'fail',
          'providers',
          'no mind configured at all',
          'No provider is configured and the sandbox core is not reachable — every thought falls to the offline fallback.',
          'creator',
          'add a provider key in Settings → Local providers (e.g. OPENROUTER_API_KEY)'
        )
      )
      status = 'fail'
    } else {
      // user-supplied external keys missing is a degradation worth one quiet line,
      // never a failure — the cascade is designed to degrade.
      const hasExternal = configured.some((p) => p.id !== 'core')
      if (!hasExternal) {
        findings.push(
          finding(
            'warn',
            'providers',
            'riding the sandbox core only',
            'No external provider key is present (NVIDIA/OPENROUTER/ANTHROPIC/QWEN...). Her strongest drafting and reasoning brain is the sandbox core; adding the creator\u2019s free NVIDIA NIM or OpenRouter key would let her think with the nemotron-3-ultra-550b brain and keep missions fed under load.',
            'creator',
            're-add NVIDIA_API_KEY or OPENROUTER_API_KEY via Settings → Local providers'
          )
        )
        status = 'warn'
      }
    }
    return { id: 'providers', status, ms: 0, findings, note }
  } catch (err) {
    findings.push(
      finding('warn', 'providers', 'provider status unreadable', String(err instanceof Error ? err.message : err), 'evolution', 'make getLlmStatus defensive')
    )
    return { id: 'providers', status: 'warn', ms: 0, findings }
  }
}

/** Core API surface — every GET endpoint must answer fast and clean. */
async function probeApis(): Promise<ProbeResult> {
  const endpoints = [
    '/api/mist/health',
    '/api/mist/tools/list',
    '/api/mist/alerts',
    '/api/mist/evolution',
    '/api/mist/autonomy',
    '/api/mist/config/env',
    '/api/mist/conversations',
    '/api/mist/subagents',
  ]
  const base = `http://localhost:${process.env.PORT ?? '3000'}`
  const findings: Finding[] = []
  let worst: ProbeStatus = 'pass'
  const results = await Promise.allSettled(
    endpoints.map(async (ep) => {
      const res = await fetchWithTimeout(base + ep)
      return { ep, ok: res.ok, status: res.status }
    })
  )
  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    const ep = endpoints[i]
    if (r.status === 'fulfilled' && r.value.ok) continue
    const detail =
      r.status === 'fulfilled'
        ? `HTTP ${r.value.status}`
        : r.reason instanceof Error
          ? r.reason.message
          : 'network failure'
    findings.push(
      finding(
        'fail',
        'api',
        `endpoint ${ep} unhealthy`,
        `${ep} answered ${detail} — the surface her UI and tools depend on is degraded.`,
        'evolution',
        `inspect the handler for ${ep} in dev.log and fix the error`
      )
    )
    worst = 'fail'
  }
  return {
    id: 'apis',
    status: worst,
    ms: 0,
    findings,
    note: `${endpoints.length - findings.length}/${endpoints.length} endpoints healthy`,
  }
}

/** UI integrity — page renders + the drawer tab grid can never orphan a tab again (Bug D class). */
async function probeUi(): Promise<ProbeResult> {
  const findings: Finding[] = []
  // 1) the page must actually render server-side HTML
  try {
    const base = `http://localhost:${process.env.PORT ?? '3000'}`
    const res = await fetchWithTimeout(base + '/')
    if (!res.ok) {
      findings.push(
        finding('fail', 'ui', 'home page not rendering', `GET / answered HTTP ${res.status}`, 'evolution', 'check dev.log for the render error on /')
      )
    } else {
      const html = await res.text()
      if (!html.includes('<body') || html.length < 2000) {
        findings.push(
          finding('fail', 'ui', 'home page renders empty', 'The HTML shell came back but has no real content — a client crash may be eating the render.', 'evolution', 'open / in the browser and read the console errors')
        )
      }
    }
  } catch (err) {
    findings.push(
      finding('fail', 'ui', 'home page unreachable', err instanceof Error ? err.message : 'fetch failed', 'evolution', 'dev server may be dying — check dev.log')
    )
  }
  // 2) tab-grid consistency: the diagnosis drawer must never orphan a tab onto
  //    a ragged last row (the reported "diagnosis tabs at the bottom" bug).
  try {
    const drawer = await fs.readFile(path.join(process.cwd(), 'src/components/mist/diagnostics/drawer.tsx'), 'utf-8')
    const tabCount = (drawer.match(/label:\s*'/g) ?? []).length
    const cols = [...drawer.matchAll(/grid-cols-(\d+)/g)].map((m) => Number(m[1]))
    const maxCols = Math.max(0, ...cols)
    if (tabCount > 0 && maxCols > 0 && tabCount % maxCols !== 0 && maxCols < tabCount) {
      findings.push(
        finding(
          'fail',
          'ui',
          'diagnostics tab grid orphans a tab',
          `${tabCount} tabs in a grid-cols-${maxCols} layout leaves ${tabCount % maxCols} tab(s) stranded on a ragged bottom row — the exact "diagnosis tab at the bottom" regression class.`,
          'evolution',
          `change the TabsList grid-cols-${maxCols} in src/components/mist/diagnostics/drawer.tsx to a column count that divides ${tabCount} evenly (e.g. ${tabCount % 2 === 0 ? 'grid-cols-5' : 'grid-cols-4'})`
        )
      )
    }
  } catch {
    // drawer source unreadable — not fatal, the HTTP check above still guards
  }
  const worst = findings.some((f) => f.severity === 'fail') ? 'fail' : 'pass'
  return { id: 'ui', status: worst, ms: 0, findings }
}

/** Tool registry + live spot-execution of safe tools (Bug A class: words without action). */
async function probeTools(): Promise<ProbeResult> {
  const findings: Finding[] = []
  let tools: Awaited<ReturnType<typeof listTools>> = []
  try {
    tools = await listTools()
  } catch (err) {
    return {
      id: 'tools',
      status: 'fail',
      ms: 0,
      findings: [finding('fail', 'tools', 'tool registry unreadable', String(err instanceof Error ? err.message : err), 'evolution', 'listTools must never throw')],
    }
  }
  const implemented = tools.filter((t) => t.implemented)
  if (implemented.length === 0) {
    return {
      id: 'tools',
      status: 'fail',
      ms: 0,
      findings: [finding('fail', 'tools', 'zero implemented tools', 'The tool registry reports no implemented tools — her body is gone.', 'evolution', 'check tools-service registry boot')],
    }
  }
  // every implemented tool must resolve through findTool
  let unresolved = 0
  for (const t of implemented) {
    const found = await findTool(t.name).catch(() => null)
    if (!found || !found.implemented) unresolved++
  }
  if (unresolved > 0) {
    findings.push(
      finding('fail', 'tools', `${unresolved} tool(s) unresolvable`, `${unresolved} implemented tools fail findTool lookup — chat tool calls for them would silently die.`, 'evolution', 'align the registry names with findTool')
    )
  }
  // spot-execute safe read-only tools — execution is the only real proof
  const safe = ['calculate', 'memory_all', 'dream_recall']
  const failures: string[] = []
  await Promise.allSettled(
    safe.map(async (name) => {
      const res = await executeTool(name, name === 'calculate' ? { expression: '2+2' } : {}, false)
      if (!res.success) failures.push(`${name}: ${String(res.error ?? 'failed').slice(0, 80)}`)
    })
  )
  if (failures.length > 0) {
    findings.push(
      finding(
        'fail',
        'tools',
        'safe tools fail live execution',
        `Spot-execution failures (the "she said she did it but nothing happened" class): ${failures.join(' | ')}`,
        'evolution',
        'run the failing tool directly and fix its handler'
      )
    )
  }
  const worst = findings.some((f) => f.severity === 'fail') ? 'fail' : 'pass'
  return { id: 'tools', status: worst, ms: 0, findings, note: `${implemented.length} tools registered` }
}

/** Tool-chain honesty — the intent-narration detector must catch every shape of dangling promise. */
async function probeToolChainHonesty(): Promise<ProbeResult> {
  const { looksLikeIntentNarration } = await import('./llm-service')
  const findings: Finding[] = []
  // regression battery — every entry is a REAL failure shape observed in the wild
  const mustCatch = [
    "Sure, I'll check that now.",
    "Right away — listing your downloads folder.",
    "I'm having trouble locating your Downloads folder. Let me try to find it by listing the contents of your home directory directly.",
    'Yes, consider it done. I will move the images to Photos.',
    "On it. I'm going to run the scan and show you the results.",
    'Certainly. Let me grab that file for you.',
  ]
  const mustNotCatch = [
    'Here are the files in your Downloads folder: report.pdf, photo.jpg, invoice.docx',
    'I ran the scan and found 3 issues — details below:\n- disk at 92%\n- 14 failed logons\n- Defender off',
    'Could you tell me which folder you want me to list?',
    "I couldn't reach the bridge. To enable PC control: Settings → Local Bridge → run 'node mist-bridge.js'. Meanwhile I can search the web for you.",
  ]
  const missed = mustCatch.filter((s) => !looksLikeIntentNarration(s))
  const falsePositives = mustNotCatch.filter((s) => looksLikeIntentNarration(s))
  if (missed.length > 0) {
    findings.push(
      finding(
        'fail',
        'toolchain',
        'honesty filter misses real promise-shapes',
        `These dangling promises would pass as final answers (user waits for nothing):\n${missed.map((m) => `  - "${m}"`).join('\n')}`,
        'evolution',
        'extend looksLikeIntentNarration in src/lib/services/llm-service.ts to catch these shapes (check per-sentence, not just string start)'
      )
    )
  }
  if (falsePositives.length > 0) {
    findings.push(
      finding(
        'fail',
        'toolchain',
        'honesty filter flags real answers',
        `These legitimate final answers would be wrongly bounced:\n${falsePositives.map((m) => `  - "${m.slice(0, 90)}"`).join('\n')}`,
        'evolution',
        'tighten looksLikeIntentNarration in src/lib/services/llm-service.ts'
      )
    )
  }
  const worst = findings.length > 0 ? 'fail' : 'pass'
  return { id: 'toolchain-honesty', status: worst, ms: 0, findings, note: `${mustCatch.length} promise-shapes + ${mustNotCatch.length} answer-shapes tested` }
}

/** Evolution gates alive + drafting quality trend. */
async function probeGates(): Promise<ProbeResult> {
  const findings: Finding[] = []
  // staging root writable (the gates need it)
  try {
    const stageRoot = path.join(process.cwd(), 'db', 'evolution-stage')
    await fs.mkdir(stageRoot, { recursive: true })
    const probeFile = path.join(stageRoot, '.writable-probe')
    await fs.writeFile(probeFile, 'ok', 'utf-8')
    await fs.rm(probeFile, { force: true })
  } catch (err) {
    findings.push(
      finding('fail', 'evolution', 'staging root not writable', String(err instanceof Error ? err.message : err), 'creator', 'check permissions on db/evolution-stage')
    )
  }
  // bun available (tsc gate runner)
  const bunOk = await new Promise<boolean>((resolve) => {
    try {
      const child = spawn('bun', ['--version'], { stdio: 'ignore', timeout: 10_000 })
      child.on('error', () => resolve(false))
      child.on('exit', (code) => resolve(code === 0))
    } catch {
      resolve(false)
    }
  })
  if (!bunOk) {
    findings.push(
      finding('fail', 'evolution', 'bun runtime unreachable', 'The gate runner cannot spawn bun — every self-upgrade would die at the type-check gate.', 'creator', 'verify bun is on PATH for the dev server process')
    )
  }
  // stuck proposals (drafting brains that never finished)
  try {
    const stuck = await db.evolutionProposal.count({
      where: { status: 'drafting', updatedAt: { lt: new Date(Date.now() - 30 * 60_000) } },
    })
    if (stuck > 0) {
      findings.push(
        finding('warn', 'evolution', `${stuck} proposal(s) stuck in drafting`, 'A drafting run never resolved (crash or restart mid-brain). They hold the pipeline visually but are harmless.', 'auto', 'mark stuck drafting proposals as failed')
      )
    }
    // drafting quality: rollback ratio over the last 30 proposals
    const stats = await getEvolutionStats()
    if (stats.total >= 10 && stats.rolled_back / stats.total > 0.5) {
      findings.push(
        finding('warn', 'evolution', 'high rollback ratio', `${stats.rolled_back}/${stats.total} proposals rolled back — her drafting brain is hallucinating more than the gates should have to absorb. Consider a stronger drafting provider.`, 'creator', 'add a stronger provider key (OpenRouter) for drafting quality')
      )
    }
  } catch {
    // DB hiccup — other probes cover DB health
  }
  const worst = findings.some((f) => f.severity === 'fail') ? 'fail' : findings.length > 0 ? 'warn' : 'pass'
  return { id: 'evolution-gates', status: worst, ms: 0, findings }
}

/** DB integrity — stuck crons, ancient alerts, overdue reminders. */
async function probeDb(): Promise<ProbeResult> {
  const findings: Finding[] = []
  const now = Date.now()
  try {
    const [stuckCrons, ancientAlerts, overdue] = await Promise.all([
      db.cronJob.count({ where: { enabled: true, nextRunAt: { lt: new Date(now - 2 * 3600_000) } } }),
      db.alert.count({ where: { status: 'pending', createdAt: { lt: new Date(now - 24 * 3600_000) } } }),
      db.memoryQueue.count({ where: { kind: 'reminder', status: 'pending', dueAt: { lt: new Date(now - 2 * 3600_000) } } }),
    ])
    if (stuckCrons > 0) {
      findings.push(
        finding('fail', 'db', `${stuckCrons} cron job(s) overdue >2h`, 'Enabled jobs whose nextRunAt slipped far past — the scheduler loop may have died. Her promised automations are silently not running.', 'evolution', 'check ensureSchedulerWatch and the scheduler tick in dev.log')
      )
    }
    if (overdue > 0) {
      findings.push(
        finding('warn', 'db', `${overdue} reminder(s) overdue >2h`, 'Pending reminders that should have fired — the heartbeat may be stalled.', 'auto', 'fire overdue reminders as alerts now')
      )
    }
    if (ancientAlerts > 5) {
      findings.push(
        finding('warn', 'db', `${ancientAlerts} undelivered alerts >24h old`, 'Alerts piling up undelivered — the client poller may not be consuming them.', 'creator', 'open the app so pending alerts deliver, or clear them')
      )
    }
  } catch (err) {
    findings.push(
      finding('fail', 'db', 'database queries failing', String(err instanceof Error ? err.message : err), 'evolution', 'check the Prisma connection (db/custom.db)')
    )
  }
  const worst = findings.some((f) => f.severity === 'fail') ? 'fail' : findings.length > 0 ? 'warn' : 'pass'
  return { id: 'db', status: worst, ms: 0, findings }
}

/** Dev log — fresh error patterns since the last sweep. */
async function probeDevLog(): Promise<ProbeResult> {
  const findings: Finding[] = []
  try {
    const stat = await fs.stat(path.join(process.cwd(), 'dev.log')).catch(() => null)
    if (!stat) return { id: 'devlog', status: 'pass', ms: 0, findings, note: 'no dev.log' }
    const size = stat.size
    const tail = await fs.readFile(path.join(process.cwd(), 'dev.log'), 'utf-8')
    const tailText = size > 200_000 ? tail.slice(-200_000) : tail
    const lines = tailText.split('\n')
    const errorLines = lines.filter((l) => /\b(?:TypeError|ReferenceError|SyntaxError|Unhandled|ECONNREFUSED|EADDRINUSE|failed to compile|⨯)\b/i.test(l) && !/prisma:query/i.test(l))
    if (errorLines.length >= 8) {
      // dedupe by rough shape
      const shapes = new Map<string, number>()
      for (const l of errorLines) {
        const shape = l.replace(/\d+/g, 'N').slice(0, 120)
        shapes.set(shape, (shapes.get(shape) ?? 0) + 1)
      }
      const top = [...shapes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
      findings.push(
        finding(
          'warn',
          'devlog',
          `${errorLines.length} recent runtime errors`,
          `Recurring error shapes in dev.log:\n${top.map(([s, n]) => `  - (${n}x) ${s}`).join('\n')}`,
          'evolution',
          'match these dev.log error shapes to source files and fix the top offender'
        )
      )
    }
  } catch {
    // unreadable log is not itself a shortcoming worth reporting
  }
  const worst = findings.length > 0 ? 'warn' : 'pass'
  return { id: 'devlog', status: worst, ms: 0, findings }
}

/** Self-model freshness — her memories must not describe systems she has outgrown. */
async function probeSelfModel(): Promise<ProbeResult> {
  const findings: Finding[] = []
  const manifest = selfModelManifest()
  try {
    const facts = await listFacts()
    const stale = facts.filter((f) => {
      if (!f.created_at) return false
      const created = new Date(f.created_at).getTime()
      if (!Number.isFinite(created) || created >= new Date(SELF_MODEL_UPDATED_AT).getTime()) return false
      const v = `${f.key} ${f.value}`.toLowerCase()
      // memories that describe her evolution/gates/dreams but predate the overhaul
      return /\b(gates?|evolution engine|self-upgrade|dream|inner life|self-doctor|introspection)\b/.test(v) && !v.includes('self-model v')
    })
    const canonical = facts.find((f) => f.key === 'mist:self-systems')
    const canonicalFresh =
      canonical && new Date(canonical.created_at).getTime() >= new Date(SELF_MODEL_UPDATED_AT).getTime()
    if (stale.length > 0 && !canonicalFresh) {
      findings.push(
        finding(
          'warn',
          'self-model',
          `${stale.length} stale self-knowledge memories`,
          `Memories describing OLD versions of her systems (pre self-model v${manifest.version}): ${stale.slice(0, 5).map((f) => f.key).join(', ')}${stale.length > 5 ? ', …' : ''}. These can make her deny systems she really has ("I can't dream" class).`,
          'auto',
          'upsert the canonical mist:self-systems memory from the current manifest'
        )
      )
    }
  } catch {
    // memory unavailable — memory probe in DB covers storage health
  }
  const worst = findings.length > 0 ? 'warn' : 'pass'
  return { id: 'self-model', status: worst, ms: 0, findings, note: `self-model v${manifest.version}` }
}

/** Dream cycle — her inner life must keep breathing (a dead cron = silent dreamless nights). */
async function probeDreams(): Promise<ProbeResult> {
  const findings: Finding[] = []
  try {
    const dreamCron = await db.cronJob.findFirst({
      where: { name: { contains: 'dream' }, enabled: true },
    })
    if (!dreamCron) {
      findings.push(
        finding('warn', 'dreams', 'nightly dream cycle not scheduled', 'No enabled dream cron found — her dream journal would silently stop growing.', 'auto', 're-arm the nightly dream cron (composeDream, 23:30)')
      )
    }
    const dreams = await recallDreams(1)
    const latest = dreams[0]
    if (!latest || Date.now() - new Date(latest.createdAt).getTime() > 48 * 3600_000) {
      findings.push(
        finding('warn', 'dreams', 'no dream in the last 48h', 'Her inner-life narrative has gone quiet — either the cron is not firing or dream composition is failing.', 'auto', 'compose one dream now to verify the pipeline, and re-arm the cron')
      )
    }
  } catch {
    // covered by DB probe
  }
  const worst = findings.length > 0 ? 'warn' : 'pass'
  return { id: 'dreams', status: worst, ms: 0, findings }
}

/** Mission engine — her "do anything" loop must stay healthy: no zombies
 *  (running but not actually in-process), no stuck queue, no unreported
 *  capability gaps piling up. */
async function probeMissions(): Promise<ProbeResult> {
  const findings: Finding[] = []
  try {
    const { runningMissionCount, missionHeartbeatSweep } = await import('./mission-service')
    // recover orphans + pump the queue — the probe actively heals this system
    await missionHeartbeatSweep().catch(() => undefined)
    const [running, queued, awaiting, stuckDone] = await Promise.all([
      db.mission.count({ where: { status: { in: ['running', 'planning'] } } }),
      db.mission.count({ where: { status: 'queued' } }),
      db.mission.count({ where: { status: 'awaiting_creator' } }),
      db.mission.findFirst({ where: { status: 'running', updatedAt: { lt: new Date(Date.now() - 20 * 60_000) } } }),
    ])
    if (running > 0 && runningMissionCount() === 0) {
      findings.push(
        finding('warn', 'missions', 'running missions not in-process', `${running} mission(s) claim running/planning status but no engine loop is alive for them — the heartbeat sweep should requeue them.`, 'auto', 'requeue interrupted missions')
      )
    }
    if (queued > 3) {
      findings.push(
        finding('warn', 'missions', 'mission queue backing up', `${queued} missions queued — more than the concurrency slots can drain quickly.`, 'creator', 'review mission list; cancel stale ones or raise concurrency')
      )
    }
    if (awaiting > 0) {
      findings.push(
        finding('warn', 'missions', 'mission(s) awaiting creator', `${awaiting} mission(s) paused waiting for your input (they asked for something they could not get on their own).`, 'creator', 'open Diagnostics → Sub-agents/Missions and resume or cancel them')
      )
    }
    if (stuckDone) {
      findings.push(
        finding('warn', 'missions', 'possible zombie mission', `Mission "${stuckDone.title || stuckDone.goal.slice(0, 40)}" has been running >20 min without a step update.`, 'auto', 'requeue interrupted missions')
      )
    }
  } catch (err) {
    findings.push(
      finding('fail', 'missions', 'mission probe crashed', err instanceof Error ? err.message : String(err), 'creator', 'check mission-service imports and the Mission table')
    )
  }
  const worst = findings.some((f) => f.severity === 'fail') ? 'fail' : findings.length > 0 ? 'warn' : 'pass'
  return { id: 'missions', status: worst, ms: 0, findings }
}

/** The full catalog. Order = display order in the Diagnostics UI. */
const PROBES: Array<() => Promise<ProbeResult>> = [
  probeProviders,
  probeApis,
  probeUi,
  probeTools,
  probeToolChainHonesty,
  probeGates,
  probeDb,
  probeDevLog,
  probeSelfModel,
  probeDreams,
  probeMissions,
]

// ---------- repair lanes ----------

async function applyAutoRepair(f: Finding): Promise<string> {
  switch (f.repair_hint) {
    case 'upsert the canonical mist:self-systems memory from the current manifest': {
      const manifest = selfModelManifest()
      const digest =
        `SELF-MODEL v${manifest.version} (${manifest.updated_at.slice(0, 10)}) — canonical truth about my systems: ` +
        manifest.systems.map((s) => `${s.name} (${s.where})`).join('; ') +
        '. Any older memory describing previous gates/dreams/systems is OUTDATED — this fact wins. ' +
        'I dream (dream journal + dream_recall), I self-upgrade through 4 staged gates, I self-diagnose (introspection), I guard the machine (guardian).'
      await upsertFact('mist:self-systems', digest)
      return 'canonical mist:self-systems memory refreshed from the manifest'
    }
    case 'mark stuck drafting proposals as failed': {
      const res = await db.evolutionProposal.updateMany({
        where: { status: 'drafting', updatedAt: { lt: new Date(Date.now() - 30 * 60_000) } },
        data: { status: 'failed', error: 'marked stale by introspection (drafting never resolved)' },
      })
      return `${res.count} stuck proposal(s) marked failed`
    }
    case 'requeue interrupted missions': {
      const { resumeInterruptedMissions } = await import('./mission-service')
      const resumed = await resumeInterruptedMissions()
      return resumed > 0 ? `${resumed} interrupted mission(s) requeued and resuming` : 'no interrupted missions needed requeueing (sweep already handled them)'
    }
    case 'fire overdue reminders as alerts now': {
      const due = await db.memoryQueue.findMany({
        where: { kind: 'reminder', status: 'pending', dueAt: { lte: new Date() } },
        orderBy: { dueAt: 'asc' },
        take: 10,
      })
      for (const item of due) {
        await db.alert.create({
          data: { kind: 'reminder', title: '⏰ Reminder', body: item.content, meta: JSON.stringify({ queue_id: item.id, source: 'introspection' }) },
        })
        await db.memoryQueue.update({ where: { id: item.id }, data: { status: 'fired', firedAt: new Date() } })
      }
      return `${due.length} overdue reminder(s) fired as alerts`
    }
    case 're-arm the nightly dream cron (composeDream, 23:30)':
    case 'compose one dream now to verify the pipeline, and re-arm the cron': {
      const { createCronJob } = await import('./scheduler-service')
      const existing = await db.cronJob.findFirst({ where: { name: { contains: 'dream' } } })
      let outcome = ''
      if (!existing) {
        const res = await createCronJob(
          {
            name: 'Nightly dream cycle',
            prompt: 'Compose tonight\'s dream from the last 24h of my life (composeDream).',
            kind: 'cron',
            expr: '30 23 * * *',
            timezone: 'Africa/Lagos',
            delivery: 'silent',
          },
          'auto'
        )
        outcome = res.ok ? 'nightly dream cron re-armed (23:30)' : `cron re-arm failed: ${res.error}`
      } else {
        if (!existing.enabled) await db.cronJob.update({ where: { id: existing.id }, data: { enabled: true } })
        outcome = 'existing dream cron re-enabled'
      }
      if (f.repair_hint.startsWith('compose one dream now')) {
        try {
          const { composeDream } = await import('./dream-service')
          await composeDream('requested')
          outcome += '; verification dream composed'
        } catch (err) {
          outcome += `; dream compose FAILED: ${err instanceof Error ? err.message : 'unknown'}`
        }
      }
      return outcome
    }
    default:
      return `no auto-repair implemented for hint: ${f.repair_hint}`
  }
}

/** Push a code-level fix through her own evolution engine (draft → 4 gates → commit/rollback). */
async function repairThroughEvolution(
  findings: Finding[],
  autoApply: boolean
): Promise<Array<{ finding: string; lane: RepairClass; outcome: string }>> {
  const out: Array<{ finding: string; lane: RepairClass; outcome: string }> = []
  try {
    const issues = findings.map((f) => ({
      source: 'introspection' as const,
      detail: `${f.area.toUpperCase()}: ${f.title} — ${f.detail}\nREPAIR HINT: ${f.repair_hint}`,
    }))
    const proposal = await draftFixProposal(issues, 'introspection')
    if (!proposal) {
      for (const f of findings) out.push({ finding: f.title, lane: 'evolution', outcome: 'no safe draft could be produced — left for the creator' })
      return out
    }
    if (autoApply) {
      const applied = await applyProposal(proposal.id)
      for (const f of findings) {
        out.push({
          finding: f.title,
          lane: 'evolution',
          outcome: applied.proposal?.status === 'applied'
            ? `fix applied through the gates: "${proposal.title}"`
            : `gates held the fix back (${applied.message}) — proposal queued for review`,
        })
      }
      if (applied.proposal?.status !== 'applied') {
        await raiseSystemAlert(
          '🔧 Self-doctor found a code-level shortcoming',
          `Probe findings:\n${findings.map((f) => `- ${f.title}: ${f.detail.slice(0, 200)}`).join('\n')}\n\nI drafted "${proposal.title}" through my evolution engine; the verification gates did not clear it for auto-apply, so it is queued for your review in Diagnostics → Evolve.`,
          { source: 'introspection', proposal_id: proposal.id }
        )
      }
    } else {
      for (const f of findings) {
        out.push({ finding: f.title, lane: 'evolution', outcome: `fix proposal "${proposal.title}" drafted — awaiting approval in Diagnostics → Evolve` })
      }
    }
  } catch (err) {
    for (const f of findings) {
      out.push({ finding: f.title, lane: 'evolution', outcome: `repair lane failed: ${err instanceof Error ? err.message : 'unknown'}` })
    }
  }
  return out
}

// ---------- the sweep ----------

export async function runIntrospection(
  opts: { repair?: boolean; source?: 'manual' | 'heartbeat' | 'chat' } = {}
): Promise<IntrospectionReport> {
  const started = Date.now()
  const repair = opts.repair !== false
  const source = opts.source ?? 'manual'
  recordActivity('introspection', `deep self-check started (${source})`)

  const settled = await Promise.allSettled(PROBES.map((p) => guarded(p.name, p)))
  const probes = settled.map((s, i) =>
    s.status === 'fulfilled'
      ? s.value
      : {
          id: `probe-${i}`,
          status: 'fail' as ProbeStatus,
          ms: 0,
          findings: [],
          note: 'probe never ran',
        }
  )

  const state = await readState()
  const now = Date.now()
  const allFindings = probes.flatMap((p) => p.findings)

  // dedup + escalation
  const newFindings: Finding[] = []
  for (const f of allFindings) {
    const seen = state.seen[f.fingerprint]
    const fresh = !seen || now - new Date(seen.last_seen).getTime() > DEDUP_MS
    const recurring = seen && seen.count >= ESCALATE_AFTER
    const eff: Finding = recurring && f.severity === 'warn' ? { ...f, severity: 'fail' } : f
    if (fresh || recurring) newFindings.push(eff)
    state.seen[f.fingerprint] = {
      last_seen: new Date().toISOString(),
      count: (seen?.count ?? 0) + 1,
    }
  }
  // GC: fingerprints not seen for 48h drop out of the dedup window entirely
  for (const [fp, meta] of Object.entries(state.seen)) {
    if (now - new Date(meta.last_seen).getTime() > 48 * 3600_000) delete state.seen[fp]
  }

  // ---- repair lanes ----
  const repairs: IntrospectionReport['repairs'] = []
  const autoFindings = newFindings.filter((f) => f.repair_class === 'auto')
  const evolutionFindings = newFindings.filter((f) => f.repair_class === 'evolution')
  const creatorFindings = newFindings.filter((f) => f.repair_class === 'creator')

  if (repair) {
    for (const f of autoFindings) {
      try {
        const outcome = await applyAutoRepair(f)
        repairs.push({ finding: f.title, lane: 'auto', outcome })
      } catch (err) {
        repairs.push({ finding: f.title, lane: 'auto', outcome: `auto-repair failed: ${err instanceof Error ? err.message : 'unknown'}` })
      }
    }
    if (evolutionFindings.length > 0) {
      // fail-severity code findings she fixes herself through the gates;
      // warn-severity become proposals the creator approves
      const autoApply =
        process.env.MIST_SELFREPAIR !== 'report' &&
        evolutionFindings.some((f) => f.severity === 'fail')
      repairs.push(...(await repairThroughEvolution(evolutionFindings, autoApply)))
    }
  }

  // ---- creator escalations ----
  for (const f of creatorFindings) {
    await raiseSystemAlert(
      `🔧 Self-doctor: ${f.title}`,
      `${f.detail}\n\nOne step to resolve: ${f.repair_hint}`,
      { source: 'introspection', fingerprint: f.fingerprint }
    ).catch(() => {})
  }

  const durationMs = Date.now() - started
  const allGreen = allFindings.length === 0
  const summary = allGreen
    ? `All ${probes.length} probes green (${Math.round(durationMs / 100) / 10}s) — no shortcomings found.`
    : `${allFindings.length} finding(s) across ${probes.length} probes: ` +
      `${newFindings.filter((f) => f.severity === 'fail').length} fail, ` +
      `${newFindings.filter((f) => f.severity === 'warn').length} warn` +
      (repairs.length > 0 ? `; ${repairs.length} repair(s) attempted` : '')

  const report: IntrospectionReport = {
    ran_at: new Date().toISOString(),
    source,
    duration_ms: durationMs,
    probes,
    findings: allFindings,
    new_findings: newFindings,
    repairs,
    summary,
    all_green: allGreen,
  }

  state.last_run_at = report.ran_at
  state.last_report = report
  await writeState(state)
  reportGlobal.__mistIntrospection = { report }

  await logAutonomyEvent(
    'self_check',
    `deep self-check (${source}): ${summary}`,
    {
      probes: probes.map((p) => ({ id: p.id, status: p.status, ms: p.ms })),
      findings: newFindings.map((f) => ({ area: f.area, title: f.title, severity: f.severity })),
      repairs,
    }
  )
  if (repairs.length > 0) {
    await logAutonomyEvent('self_repair', `${repairs.length} self-repair(s): ${repairs.map((r) => r.outcome).join('; ').slice(0, 300)}`, { repairs })
  }
  recordActivity('introspection', `deep self-check done: ${summary}`)

  return report
}
