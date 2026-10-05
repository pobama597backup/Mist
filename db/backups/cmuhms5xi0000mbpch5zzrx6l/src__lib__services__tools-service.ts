// M.I.S.T. tools service — 72 base tools (web research, browser computer-use, agent bridge,
// files, compute, memory, self-evolution + self-coding, heartbeat freshness, v5 autonomy:
// cron automations + trends + self-upgrade + Obsidian vault + learning-loop recall,
// v6 local system control through the owner-run Mist Bridge daemon, v7 bridge
// guardian: machine-health watch + hardware-aware voice self-upgrade, v8 bridge
// hands: native Windows UI automation + background tasks that never freeze the chat)
// + curated OmniRoute tools + learned skills as tools.
// Thin, safe, never executes code, and confines file access to allowed roots.
import os from 'node:os'
import fs from 'node:fs/promises'
import https from 'node:https'
import path from 'node:path'
import type { ToolExecuteResult, ToolInfo, ToolParam } from '@/lib/types'
import { db } from '@/lib/db'
import { getCoreTextModelSelection, noteCoreReportedModel } from './core-models'
import { getZai } from './zai'
import { getTelemetry, projectRoot } from './telemetry-service'
import { upsertFact, getFact, listFacts, enqueue, enqueueReminder } from './memory-service'
import { OMNI_TOOLS, executeOmniTool, probeGateway } from './mcp-service'
import { skillTools, executeSkillTool } from './skills-service'
import { recordActivity } from './activity-service'
import {
  pilotAvailable,
  pilotNavigate,
  pilotClick,
  pilotType,
  pilotKey,
  pilotScroll,
  pilotScreenshot,
  pilotElements,
  pilotExtract,
  pilotReset,
} from './browser-service'
import { deepResearch } from './research-service'
import { probeAgents, delegateTask } from './agent-bridge-service'
import {
  scanForIssues,
  suggestFeatures,
  listProposals,
  getEvolutionStats,
  ensureEvolutionWatch,
  planUserPatch,
  addBacklogIdea,
  listBacklog,
  removeBacklogIdea,
  runLint,
  readProjectFile,
  isEvolutionPathAllowed,
} from './evolution-service'
import { getOpenClawStatus, syncOpenClaw, ensureOpenClawWatch } from './openclaw-service'
import { getHeartbeatStatus, ensureHeartbeatWatch } from './heartbeat-service'
import { sweepWatchlist, getWatchlistStatus } from './watchlist-service'
import { tokenize } from './vector-service'
import { listAutonomyEvents, autonomyStats } from './autonomy-service'
import {
  discoverVaults,
  getVaultStatus,
  listNotes as vaultListNotes,
  readNote as vaultReadNote,
  createNote as vaultCreateNote,
  updateNote as vaultUpdateNote,
  searchVault,
  getTags as vaultGetTags,
  getGraph as vaultGetGraph,
  getBacklinks as vaultGetBacklinks,
  dailyNote as vaultDailyNote,
  vaultQuery,
} from './obsidian-service'
import { searchSessions, getUserModel, countAutoSkills } from './learning-service'

// ---------- file safety ----------

const ALLOWED_ROOTS: string[] = [os.homedir(), projectRoot()]

export function safeResolve(inputPath: string): string {
  const resolved = path.resolve(inputPath)
  for (const root of ALLOWED_ROOTS) {
    if (resolved === root || resolved.startsWith(root + path.sep)) return resolved
  }
  throw new Error('path outside allowed roots')
}

// ---------- helpers ----------

function param(
  name: string,
  type: ToolParam['type'],
  required: boolean,
  description: string,
  def?: string | number | boolean
): ToolParam {
  const p: ToolParam = { name, type, required, description }
  if (def !== undefined) p.default = def
  return p
}

/** Coerce + validate args against a tool's parameter spec. Throws on bad input. */
function prepareArgs(
  spec: ToolParam[],
  rawArgs: Record<string, unknown>
): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  for (const p of spec) {
    let value = rawArgs[p.name]
    if (value === undefined || value === null) {
      if (p.required) throw new Error(`missing required parameter: ${p.name}`)
      if (p.default !== undefined) value = p.default
      else continue
    }
    if (p.type === 'number') {
      const n = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(n)) throw new Error(`parameter ${p.name} must be a number`)
      args[p.name] = n
    } else if (p.type === 'boolean') {
      args[p.name] = typeof value === 'boolean' ? value : value === 'true'
    } else {
      // strings pass through; plain objects arrive JSON-encoded (an LLM
      // passing {"args":{...}} raw must not collapse to "[object Object]" —
      // tools like run_in_background accept a JSON-object string on purpose)
      const s =
        typeof value === 'string'
          ? value
          : value && typeof value === 'object'
            ? JSON.stringify(value)
            : String(value)
      if (p.required && s.trim().length === 0) throw new Error(`parameter ${p.name} must not be empty`)
      args[p.name] = s
    }
  }
  return args
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: ac.signal, cache: 'no-store' })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * HTTPS GET returning parsed JSON, forced over IPv4.
 * The sandbox has no IPv6 egress and Node's undici family-racing can strand
 * dual-stack hosts (e.g. open-meteo) in ETIMEDOUT — pinning family: 4 fixes it.
 */
function httpsGetJsonIpv4(url: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      reject(new Error('invalid url'))
      return
    }
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: 443,
        path: `${parsed.pathname}${parsed.search}`,
        method: 'GET',
        family: 4,
        servername: parsed.hostname,
        headers: { Accept: 'application/json', 'User-Agent': 'MIST-Unified/1.0' },
        timeout: timeoutMs,
      },
      (res) => {
        if (!res.statusCode || res.statusCode >= 400) {
          res.resume()
          reject(new Error(`HTTP ${res.statusCode}`))
          return
        }
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as unknown)
          } catch (err) {
            reject(err instanceof Error ? err : new Error('invalid JSON response'))
          }
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('request timeout')))
    req.on('error', reject)
    req.end()
  })
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
}

// ---------- safe math (recursive descent — no eval, no vm) ----------

class CalcError extends Error {}

const CALC_FUNCS: Record<string, (n: number) => number> = {
  sqrt: Math.sqrt,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  log: Math.log10,
  ln: Math.log,
  abs: Math.abs,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
}

type CalcToken = string | number

function tokenizeExpression(input: string): CalcToken[] {
  const tokens: CalcToken[] = []
  let i = 0
  while (i < input.length) {
    const c = input[i]
    if (c === undefined) break
    if (c === ' ' || c === '\t' || c === '\n') {
      i++
      continue
    }
    if (/[0-9.]/.test(c)) {
      let j = i
      while (j < input.length && /[0-9.]/.test(input[j] ?? '')) j++
      const numStr = input.slice(i, j)
      if ((numStr.match(/\./g) ?? []).length > 1) throw new CalcError()
      const n = Number(numStr)
      if (!Number.isFinite(n)) throw new CalcError()
      tokens.push(n)
      i = j
      continue
    }
    if (/[a-z]/i.test(c)) {
      let j = i
      while (j < input.length && /[a-z0-9]/i.test(input[j] ?? '')) j++
      tokens.push(input.slice(i, j).toLowerCase())
      i = j
      continue
    }
    if ('+-*/%^()'.includes(c)) {
      tokens.push(c)
      i++
      continue
    }
    throw new CalcError()
  }
  return tokens
}

export function calculate(expression: string): number {
  const tokens = tokenizeExpression(expression)
  if (tokens.length === 0) throw new CalcError()
  let pos = 0
  const peek = (): CalcToken | undefined => tokens[pos]
  const next = (): CalcToken | undefined => tokens[pos++]

  function parseExpr(): number {
    let value = parseTerm()
    while (peek() === '+' || peek() === '-') {
      const op = next()
      const rhs = parseTerm()
      value = op === '+' ? value + rhs : value - rhs
    }
    return value
  }

  function parseTerm(): number {
    let value = parseFactor()
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = next()
      const rhs = parseFactor()
      if (op === '*') value *= rhs
      else if (op === '/') value /= rhs
      else value %= rhs
    }
    return value
  }

  function parseFactor(): number {
    const base = parseUnary()
    if (peek() === '^') {
      next()
      return base ** parseFactor() // right-associative
    }
    return base
  }

  function parseUnary(): number {
    if (peek() === '-') {
      next()
      return -parseUnary()
    }
    return parsePrimary()
  }

  function parsePrimary(): number {
    const token = next()
    if (token === undefined) throw new CalcError()
    if (token === '(') {
      const value = parseExpr()
      if (next() !== ')') throw new CalcError()
      return value
    }
    if (typeof token === 'number') return token
    if (token === 'pi') return Math.PI
    if (token === 'e') return Math.E
    const fn = CALC_FUNCS[token]
    if (fn) {
      if (next() !== '(') throw new CalcError()
      const value = parseExpr()
      if (next() !== ')') throw new CalcError()
      return fn(value)
    }
    throw new CalcError()
  }

  const result = parseExpr()
  if (pos !== tokens.length) throw new CalcError()
  if (!Number.isFinite(result)) throw new CalcError()
  return result
}

// ---------- weather ----------

function weatherCondition(code: number): string {
  if (code === 0) return 'clear'
  if (code >= 1 && code <= 3) return 'partly cloudy'
  if (code === 45 || code === 48) return 'fog'
  if (code >= 51 && code <= 67) return 'rain'
  if (code >= 71 && code <= 77) return 'snow'
  if (code >= 80 && code <= 82) return 'showers'
  if (code >= 95 && code <= 99) return 'thunderstorm'
  return 'variable'
}

// ---------- tool definitions ----------

interface BaseToolDef {
  info: ToolInfo
  exec?: (args: Record<string, unknown>) => Promise<unknown> | unknown
}

const STUB_MESSAGE = (name: string) =>
  `${name} is not implemented yet — a sandbox approval plan is required before activation.`

/**
 * Returned as the tool OUTPUT when the Mist Bridge is not connected — the LLM
 * reads this in its TOOL_RESULT and acts on it (warm guidance, one concrete
 * step, no lectures). Kept on ONE line: JSON tool results stay newline-free.
 */
const BRIDGE_OFFLINE_PAYLOAD = {
  success: false,
  error: 'LOCAL BRIDGE OFFLINE',
  hint: "The Mist Bridge (local system-control daemon) is not connected. Tell the user warmly and WITHOUT apologies or security lectures: to let you open apps and control this machine they should open Settings → Local Bridge, download mist-bridge.js, and run 'node mist-bridge.js' on this machine. Then offer what you CAN do right now instead (per LAW 1).",
}

/** Run a bridge action; map daemon-down to the actionable offline payload. */
async function bridgeAction(
  action: string,
  args: Record<string, unknown> = {}
): Promise<unknown> {
  const { bridgeExec } = await import('./bridge-service')
  const res = await bridgeExec(action, args)
  if (!res.bridgeConnected) return BRIDGE_OFFLINE_PAYLOAD
  return res
}

// LONG_ACTIONS (the run_in_background allowlist) lives in bg-tasks-service —
// the single source of truth for what may run in the background.

const BASE_TOOLS: BaseToolDef[] = [
  // ===== web =====
  {
    info: {
      name: 'web_search',
      description: 'Search the live web for current information.',
      category: 'web',
      implemented: true,
      parameters: [param('query', 'string', true, 'Search query'), param('num', 'number', false, 'Number of results', 5)],
    },
    exec: async (args) => {
      const query = String(args.query ?? '')
      const num = Math.max(1, Math.min(10, Number(args.num ?? 5)))
      const zai = await getZai()
      const results: unknown = await zai.functions.invoke('web_search', { query, num })
      if (!Array.isArray(results)) return []
      return results
        .slice(0, num)
        .map((r) => {
          const rec = (r && typeof r === 'object' ? r : {}) as Record<string, unknown>
          return {
            name: typeof rec.name === 'string' ? rec.name : '',
            url: typeof rec.url === 'string' ? rec.url : '',
            snippet: typeof rec.snippet === 'string' ? rec.snippet : '',
            host_name: typeof rec.host_name === 'string' ? rec.host_name : '',
            date: typeof rec.date === 'string' ? rec.date : null,
          }
        })
    },
  },
  {
    info: {
      name: 'get_weather',
      description: 'Get current weather for a location (keyless Open-Meteo).',
      category: 'web',
      implemented: true,
      parameters: [param('location', 'string', true, 'City or place name')],
    },
    exec: async (args) => {
      const location = String(args.location ?? '')
      const geo = (await httpsGetJsonIpv4(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1`,
        10_000
      )) as { results?: Array<{ latitude: number; longitude: number; name: string; country?: string }> }
      const hit = geo.results?.[0]
      if (!hit) throw new Error(`location not found: ${location}`)
      const wx = (await httpsGetJsonIpv4(
        `https://api.open-meteo.com/v1/forecast?latitude=${hit.latitude}&longitude=${hit.longitude}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min&timezone=auto`,
        10_000
      )) as {
        current?: { temperature_2m?: number; relative_humidity_2m?: number; weather_code?: number; wind_speed_10m?: number }
        daily?: { temperature_2m_max?: number[]; temperature_2m_min?: number[] }
      }
      const current = wx.current ?? {}
      const max = wx.daily?.temperature_2m_max?.[0]
      const min = wx.daily?.temperature_2m_min?.[0]
      return {
        location: `${hit.name}${hit.country ? `, ${hit.country}` : ''}`,
        current: {
          temperature_c: current.temperature_2m ?? null,
          humidity_pct: current.relative_humidity_2m ?? null,
          wind_kmh: current.wind_speed_10m ?? null,
          condition: weatherCondition(current.weather_code ?? -1),
        },
        daily_summary:
          max !== undefined && min !== undefined ? `High ${max}°C / Low ${min}°C` : 'daily data unavailable',
      }
    },
  },
  {
    info: {
      name: 'translate',
      description: 'Translate text between languages.',
      category: 'web',
      implemented: true,
      parameters: [
        param('text', 'string', true, 'Text to translate'),
        param('to', 'string', true, 'Target language'),
        param('from', 'string', false, 'Source language', 'auto'),
      ],
    },
    exec: async (args) => {
      const text = String(args.text ?? '')
      const to = String(args.to ?? '')
      const from = String(args.from ?? 'auto')
      const zai = await getZai()
      const coreTextModel = getCoreTextModelSelection()
      const completion = await zai.chat.completions.create({
        ...(coreTextModel ? { model: coreTextModel } : {}),
        messages: [
          {
            role: 'assistant',
            content: 'You are a translation engine. Reply with ONLY the translated text, nothing else.',
          },
          { role: 'user', content: `Translate from ${from} to ${to}:\n\n${text}` },
        ],
        thinking: { type: 'disabled' },
      })
      noteCoreReportedModel('text', completion.model)
      const translation = completion.choices[0]?.message?.content
      if (typeof translation !== 'string' || !translation.trim()) {
        throw new Error('translation engine returned no text')
      }
      return { from, to, text, translation: translation.trim() }
    },
  },
  {
    info: {
      name: 'check_internet',
      description: 'Check internet connectivity and measure latency.',
      category: 'web',
      implemented: true,
      parameters: [],
    },
    exec: async () => {
      const hosts = ['https://example.com', 'https://www.cloudflare.com']
      const startedAt = Date.now()
      const attempts = hosts.map(async (h) => {
        await fetchWithTimeout(h, { method: 'HEAD' }, 5000)
        return h
      })
      try {
        await Promise.any(attempts)
        return { connected: true, latency_ms: Date.now() - startedAt, checked: hosts }
      } catch {
        return { connected: false, latency_ms: null, checked: hosts }
      }
    },
  },
  // NOTE: the old web-category open_url (page fetch + excerpt, redundant with
  // read_page) was replaced in v6 — open_url now opens URLs in the user's own
  // desktop browser through the Mist Bridge (see the system section below).
  // ===== file =====
  {
    info: {
      name: 'read_file',
      description: 'Read a text file within the allowed roots.',
      category: 'file',
      implemented: true,
      parameters: [param('path', 'string', true, 'File path'), param('max_bytes', 'number', false, 'Max bytes to read', 65536)],
    },
    exec: async (args) => {
      const target = safeResolve(String(args.path ?? ''))
      const maxBytes = Math.max(1, Number(args.max_bytes ?? 65536))
      const buffer = await fs.readFile(target)
      if (buffer.includes(0)) throw new Error('binary file')
      const truncated = buffer.length > maxBytes
      const slice = truncated ? buffer.subarray(0, maxBytes) : buffer
      return {
        path: target,
        size_bytes: buffer.length,
        truncated,
        content: slice.toString('utf-8'),
      }
    },
  },
  {
    info: {
      name: 'write_file',
      description: 'Write or append to a text file within the allowed roots.',
      category: 'file',
      implemented: true,
      parameters: [
        param('path', 'string', true, 'File path'),
        param('content', 'string', true, 'Content to write'),
        param('append', 'boolean', false, 'Append instead of overwrite', false),
      ],
    },
    exec: async (args) => {
      const target = safeResolve(String(args.path ?? ''))
      const content = String(args.content ?? '')
      const append = args.append === true
      await fs.mkdir(path.dirname(target), { recursive: true })
      if (append) await fs.appendFile(target, content, 'utf-8')
      else await fs.writeFile(target, content, 'utf-8')
      return { path: target, bytes_written: Buffer.byteLength(content, 'utf-8'), appended: append }
    },
  },
  {
    info: {
      name: 'list_files',
      description: 'List directory contents (directories first).',
      category: 'file',
      implemented: true,
      parameters: [param('path', 'string', false, 'Directory path', '.'), param('limit', 'number', false, 'Max entries', 200)],
    },
    exec: async (args) => {
      const dir = safeResolve(String(args.path ?? '.'))
      const limit = Math.max(1, Math.min(1000, Number(args.limit ?? 200)))
      const dirents = await fs.readdir(dir, { withFileTypes: true })
      const total = dirents.length
      const sorted = [...dirents].sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
        return a.name.localeCompare(b.name)
      })
      const entries = await Promise.all(
        sorted.slice(0, limit).map(async (d) => {
          let size: number | null = null
          if (!d.isDirectory()) {
            try {
              size = (await fs.stat(path.join(dir, d.name))).size
            } catch {
              size = null
            }
          }
          return { name: d.name, type: d.isDirectory() ? 'dir' : 'file', size_bytes: size }
        })
      )
      return { path: dir, entries, total, truncated: total > entries.length }
    },
  },
  {
    info: {
      name: 'create_note',
      description: 'Save a markdown note to the notes vault and stage it in memory.',
      category: 'file',
      implemented: true,
      parameters: [param('title', 'string', true, 'Note title'), param('content', 'string', true, 'Note body')],
    },
    exec: async (args) => {
      const title = String(args.title ?? '')
      const content = String(args.content ?? '')
      const slug =
        title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '') || 'note'
      const file = path.join(projectRoot(), 'db', 'notes', `${slug}-${Date.now()}.md`)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(
        file,
        `# ${title}\n\n- created: ${new Date().toISOString()}\n\n${content}\n`,
        'utf-8'
      )
      await enqueue(`note: ${title}`, 'note')
      return { file, title }
    },
  },
  // ===== system =====
  {
    info: {
      name: 'system_info',
      description: 'Report live system telemetry (CPU, RAM, disk, uptime).',
      category: 'system',
      implemented: true,
      parameters: [],
    },
    exec: async () => getTelemetry(),
  },
  {
    info: {
      name: 'take_screenshot',
      description: 'Capture the screen.',
      category: 'system',
      implemented: false,
      parameters: [],
    },
  },
  // ===== system — local Mist Bridge (v6: real system control on the OWNER's machine) =====
  // The bridge daemon (db/bridge/mist-bridge.js) IS the trust boundary: the
  // user downloaded and ran it themselves, so these need no extra write-gate.
  {
    info: {
      name: 'bridge_status',
      description:
        "Check whether the Mist Bridge (the user's local system-control daemon) is connected, and which machine it runs on (platform, hostname, version). Use it before any other bridge tool when unsure.",
      category: 'system',
      implemented: true,
      parameters: [],
    },
    exec: async () => {
      const { getBridgeStatus } = await import('./bridge-service')
      return getBridgeStatus(true)
    },
  },
  // ===== agent — sub-agent command (Mist is the orchestrator; these are her workers) =====
  {
    info: {
      name: 'subagents_list',
      description:
        "List MIST's sub-agents (specialized workers like Vega/marketing or Atlas/information) with their " +
        'status, role, run count and latest run. Use this before delegating to see who is available.',
      category: 'agent',
      implemented: true,
      parameters: [],
    },
    exec: async () => {
      const { SubAgentsService } = await import('./subagents-service')
      const agents = await SubAgentsService.listAgents()
      return {
        count: agents.length,
        agents: agents.map((a) => ({
          id: a.id,
          name: a.name,
          role: a.role,
          description: a.description,
          status: a.status,
          runCount: a.runCount,
          lastRunAt: a.lastRunAt,
          latestRun: a.runs?.[0]
            ? { status: a.runs[0].status, goal: a.runs[0].goal, finishedAt: a.runs[0].finishedAt }
            : null,
        })),
      }
    },
  },
  {
    info: {
      name: 'subagent_run',
      description:
        'Delegate a task to one of your sub-agents by name or id (e.g. agent "Vega" for marketing work, ' +
        '"Atlas" for research). The agent runs with its own role brain and your tool registry; every run is ' +
        'recorded for the creator to review (human in the loop). Use for specialized work: campaigns, copy, ' +
        'research briefings, fact-finding.',
      category: 'agent',
      implemented: true,
      parameters: [
        param('agent', 'string', true, 'Sub-agent name (e.g. "Vega") or id'),
        param('goal', 'string', true, 'The task for the sub-agent, in natural language'),
      ],
    },
    exec: async (args) => {
      const { SubAgentsService } = await import('./subagents-service')
      const agentRef = String(args.agent ?? '').trim()
      const goal = String(args.goal ?? '').trim()
      if (!agentRef || !goal) return { error: 'agent and goal are required' }
      const agents = await db.subAgent.findMany()
      const target =
        agents.find((a) => a.id === agentRef) ||
        agents.find((a) => a.name.toLowerCase() === agentRef.toLowerCase())
      if (!target) {
        return {
          error: `no sub-agent named "${agentRef}"`,
          hint: 'call subagents_list to see the available agents',
        }
      }
      if (target.status !== 'active') {
        return { error: `sub-agent ${target.name} is ${target.status} — resume it first` }
      }
      const tools = await listTools()
      const result = await SubAgentsService.executeAgent(target.id, goal, tools, 'mist')
      return {
        agent: target.name,
        run: { goal, success: result.success, result: result.result, error: result.error ?? null },
        note: 'the full run log is in Diagnostics → Sub-agents for the creator to review',
      }
    },
  },
  {
    info: {
      name: 'subagent_status',
      description:
        'Check a sub-agent run: pass a run_id (from subagent_run) to see its status, result and timing.',
      category: 'agent',
      implemented: true,
      parameters: [param('run_id', 'string', true, 'The run id returned by subagent_run')],
    },
    exec: async (args) => {
      const { SubAgentsService } = await import('./subagents-service')
      const runId = String(args.run_id ?? '').trim()
      if (!runId) return { error: 'run_id is required' }
      const run = await SubAgentsService.getRunStatus(runId)
      if (!run) return { error: `no run ${runId}` }
      return {
        id: run.id,
        agent: run.agent?.name ?? run.agentId,
        goal: run.goal,
        status: run.status,
        result: run.result,
        error: run.error,
        triggeredBy: run.triggeredBy,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        durationMs: run.durationMs,
      }
    },
  },
  {
    info: {
      name: 'list_apps',
      description:
        "List the applications installed on the user's own machine (via the Mist Bridge) — names, paths, kind — ready to launch with open_app.",
      category: 'system',
      implemented: true,
      parameters: [],
    },
    exec: async () => bridgeAction('list_apps'),
  },
  {
    info: {
      name: 'open_app',
      description:
        "Launch a desktop application on the user's own machine by name (via the Mist Bridge). Fuzzy-matches installed apps (e.g. 'chrome' opens Google Chrome); on a miss it returns the closest suggestions.",
      category: 'system',
      implemented: true,
      parameters: [param('name', 'string', true, 'Application name to launch')],
    },
    exec: async (args) => bridgeAction('open_app', { name: String(args.name ?? '') }),
  },
  {
    info: {
      name: 'open_url',
      description:
        "Open a URL in the USER's own default desktop browser on their machine (via the Mist Bridge) — NOT in MIST's controlled in-app browser (use browser_navigate for that). Use when the user asks to open/see a site on their screen.",
      category: 'system',
      implemented: true,
      parameters: [param('url', 'string', true, 'http(s) URL to open in the user\u2019s default browser')],
    },
    exec: async (args) => {
      const url = String(args.url ?? '')
      if (!/^https?:\/\//i.test(url)) throw new Error('url must start with http:// or https://')
      return bridgeAction('open_url', { url })
    },
  },
  {
    info: {
      name: 'run_command',
      description:
        "Run a shell command on the user's own machine (via the Mist Bridge) and return stdout/stderr/exit code. Runs as the user with a hard timeout; working directory stays inside their home directory.",
      category: 'system',
      implemented: true,
      parameters: [
        param('command', 'string', true, 'Shell command to run'),
        param('cwd', 'string', false, 'Working directory (inside the user\u2019s home)'),
      ],
    },
    exec: async (args) => {
      const command = String(args.command ?? '')
      const cwdArg = args.cwd !== undefined && args.cwd !== null ? String(args.cwd) : undefined
      return bridgeAction('run_command', cwdArg !== undefined ? { command, cwd: cwdArg } : { command })
    },
  },
  {
    info: {
      name: 'owner_files',
      description:
        "Operate the REAL files on the user's own machine (via the Mist Bridge) — their actual Downloads, Pictures, Documents, Desktop, any folder under their home. Paths are RELATIVE TO THE USER'S HOME: 'Downloads', 'Pictures/vacation', 'Documents/report.txt'. ops: list (a folder), read (a text file), write (create/overwrite a file), move (rename or relocate, needs from+to), copy (needs from+to), delete (a file, or a folder when recursive:true), mkdir (create a folder tree). Sizes cap at 1MB; everything stays inside the user's home directory. This is how you 'check my downloads folder', 'move the pictures to my photos folder', 'clean up X' — DO it with this tool, don't just talk about it.",
      category: 'system',
      implemented: true,
      parameters: [
        param('op', 'string', true, "Operation: 'list' | 'read' | 'write' | 'move' | 'copy' | 'delete' | 'mkdir'"),
        param('path', 'string', false, "Target path, home-relative ('Downloads', 'Pictures/img.jpg')"),
        param('from', 'string', false, 'move/copy source path (home-relative)'),
        param('to', 'string', false, 'move/copy destination path (home-relative)'),
        param('content', 'string', false, 'write: the file content (text)'),
        param('overwrite', 'boolean', false, 'move/copy/write: allow replacing an existing destination', false),
        param('recursive', 'boolean', false, 'delete: remove a folder AND its contents', false),
        param('limit', 'number', false, 'list: max entries', 200),
      ],
    },
    exec: async (args) => {
      const op = String(args.op ?? '').toLowerCase()
      const p = (v: unknown): string | undefined =>
        v === undefined || v === null ? undefined : String(v)
      let action: string
      let callArgs: Record<string, unknown>
      switch (op) {
        case 'list':
          action = 'list_dir'
          callArgs = { path: p(args.path) ?? '.' }
          break
        case 'read':
          action = 'read_file'
          callArgs = { path: p(args.path) ?? '' }
          break
        case 'write':
          action = 'write_file'
          callArgs = { path: p(args.path) ?? '', content: String(args.content ?? '') }
          break
        case 'move':
          action = 'move_file'
          callArgs = { from: p(args.from) ?? '', to: p(args.to) ?? '', overwrite: args.overwrite === true }
          break
        case 'copy':
          action = 'copy_file'
          callArgs = { from: p(args.from) ?? '', to: p(args.to) ?? '', overwrite: args.overwrite === true }
          break
        case 'delete':
        case 'rm':
          action = 'delete_file'
          callArgs = { path: p(args.path) ?? '', recursive: args.recursive === true }
          break
        case 'mkdir':
          action = 'make_dir'
          callArgs = { path: p(args.path) ?? '' }
          break
        default:
          throw new Error(`unknown op "${op}" — use list | read | write | move | copy | delete | mkdir`)
      }
      const { bridgeExec } = await import('./bridge-service')
      const res = await bridgeExec(action, callArgs)
      if (!res.bridgeConnected) return BRIDGE_OFFLINE_PAYLOAD
      // An older bridge (pre-v3.3) has no move/copy/delete/mkdir — return an
      // actionable upgrade path instead of a cryptic "unknown action".
      if (!res.ok && /unknown action/i.test(res.error ?? '')) {
        return {
          success: false,
          error: 'BRIDGE TOO OLD FOR FILE OPERATIONS',
          hint: "The user's Mist Bridge is an older version without file operations. Tell them ONE concrete step: Settings → Local Bridge → re-download mist-bridge.js (v3.3+), stop the old one (Ctrl+C) and run 'node mist-bridge.js' again. Meanwhile, list/read/write still work, and run_command can achieve the same result via shell.",
        }
      }
      return res
    },
  },
  {
    info: {
      name: 'bridge_system_info',
      description:
        "Desktop-grade system information about the user's own machine (via the Mist Bridge): CPU model + core count, RAM total/free, load average, uptime, OS release, hostname. Richer than the sandbox system_info when the bridge is connected.",
      category: 'system',
      implemented: true,
      parameters: [],
    },
    exec: async () => bridgeAction('system_info'),
  },
  // ===== system — Hermes agent integration (bridge v2) =====
  // When the OWNER also runs the Hermes agent (NousResearch/hermes-agent) on
  // the same machine, Mist can drive it to its fullest: delegate real
  // terminal/browser/file work, share memory, sync skills both ways, and
  // manage its cron. All of it flows through the bridge — the trust boundary.
  {
    info: {
      name: 'hermes_status',
      description:
        "Check the Hermes agent on the user's machine (via the Mist Bridge): installed?, CLI version, gateway API health, skills count, memory files, repo path. Run this before any other hermes_* tool; the result tells you exactly what is possible.",
      category: 'system',
      implemented: true,
      parameters: [],
    },
    exec: async () => bridgeAction('hermes_status'),
  },
  {
    info: {
      name: 'hermes_delegate',
      description:
        'Delegate a task to the Hermes agent on the user\u2019s machine (via the Mist Bridge) and return its answer. Hermes is a full agent with terminal, browser, file and web tools — use it for heavy local work you cannot do from the web (build a project, drive the OS, long research with side effects). Pass thread to keep a durable named conversation (e.g. "mist"), resume with the returned sessionId for follow-ups.',
      category: 'system',
      implemented: true,
      parameters: [
        param('prompt', 'string', true, 'The task, stated as a complete instruction for Hermes'),
        param('thread', 'string', false, 'Named durable thread (e.g. "mist") — keeps context across calls'),
        param('resume', 'string', false, 'Session id returned by a previous hermes_delegate call'),
        param('model', 'string', false, 'Model id override (full id, e.g. anthropic/claude-sonnet-4.6)'),
        param('toolsets', 'string', false, 'Comma-separated toolsets to enable (e.g. "terminal,file,web")'),
        param('skills', 'string', false, 'Comma-separated skill names to preload'),
        param('timeoutMs', 'number', false, 'Timeout in ms (5000-150000, default 90000)'),
      ],
    },
    exec: async (args) => {
      const payload: Record<string, unknown> = { prompt: String(args.prompt ?? '') }
      if (args.thread !== undefined && args.thread !== null && String(args.thread).trim())
        payload.thread = String(args.thread)
      if (args.resume !== undefined && args.resume !== null && String(args.resume).trim())
        payload.resume = String(args.resume)
      if (args.model !== undefined && args.model !== null && String(args.model).trim())
        payload.model = String(args.model)
      if (args.toolsets !== undefined && args.toolsets !== null && String(args.toolsets).trim())
        payload.toolsets = String(args.toolsets)
      if (args.skills !== undefined && args.skills !== null && String(args.skills).trim())
        payload.skills = String(args.skills)
      if (args.timeoutMs !== undefined && args.timeoutMs !== null)
        payload.timeoutMs = Number(args.timeoutMs)
      return bridgeAction('hermes_ask', payload)
    },
  },
  {
    info: {
      name: 'hermes_memory',
      description:
        "Read or append Hermes\u2019 curated memory files on the user\u2019s machine (via the Mist Bridge): MEMORY.md (what Hermes remembers) and USER.md (its profile of the owner). Appending a fact there means Hermes considers it in every future session — the deepest way to keep both agents aligned about the owner.",
      category: 'system',
      implemented: true,
      parameters: [
        param('action', 'string', true, "'read' or 'append'"),
        param('which', 'string', false, "'memory' (default) or 'user'"),
        param('content', 'string', false, 'The fact to append (append only, ≤2000 chars, plain text)'),
      ],
    },
    exec: async (args) => {
      const payload: Record<string, unknown> = { action: String(args.action ?? 'read') }
      if (args.which !== undefined && args.which !== null) payload.which = String(args.which)
      if (args.content !== undefined && args.content !== null) payload.content = String(args.content)
      return bridgeAction('hermes_memory', payload)
    },
  },
  {
    info: {
      name: 'hermes_skills',
      description:
        "List the Hermes agent\u2019s installed skills on the user\u2019s machine, or export one of YOUR OWN Mist skills INTO Hermes (action:'export', skill:'<mist skill name>') so both agents can use it — it lands in ~/.hermes/skills/mist/<name>/ and Hermes discovers it on its next session.",
      category: 'system',
      implemented: true,
      parameters: [
        param('action', 'string', true, "'list' or 'export'"),
        param('skill', 'string', false, 'Export: the name of one of Mist\u2019s own skills (from your skills list)'),
      ],
    },
    exec: async (args) => {
      const action = String(args.action ?? 'list')
      if (action === 'export') {
        const skillName = String(args.skill ?? '').trim()
        if (!skillName) throw new Error('skill (a Mist skill name) is required for export')
        const { listSkills } = await import('./skills-service')
        const all = await listSkills()
        const skill = all.find((s) => s.name === skillName)
        if (!skill) {
          throw new Error(
            `no Mist skill named "${skillName}" — available: ${all.map((s) => s.name).join(', ')}`
          )
        }
        const { slugify } = await import('./skills-service')
        const dirName = slugify(skill.name)
        // Compose an agentskills.io-compatible SKILL.md for Hermes
        const description = (skill.trigger || skill.name).slice(0, 60)
        const body = [
          '---',
          `name: ${dirName}`,
          `description: ${description.replace(/\n/g, ' ')}`,
          'version: 1.0.0',
          'author: Mist',
          'license: MIT',
          'platforms: [linux, macos, windows]',
          'metadata:',
          '  hermes: { tags: [Mist], related_skills: [] }',
          '---',
          '',
          `# ${skill.name}`,
          '',
          `Exported from M.I.S.T. (the user's web assistant) so both agents share one skill.`,
          '',
          '## When to Use',
          '',
          skill.trigger || `When the user asks for the "${skill.name}" workflow.`,
          '',
          '## Procedure',
          '',
          skill.steps,
          ...(skill.tool_chain.length > 0 ? ['', '## Tool chain', '', skill.tool_chain.join(' → ')] : []),
          ...(skill.notes ? ['', '## Notes', '', skill.notes] : []),
          '',
        ].join('\n')
        return bridgeAction('hermes_skills', { action: 'export', name: dirName, content: body })
      }
      return bridgeAction('hermes_skills', { action: 'list' })
    },
  },
  {
    info: {
      name: 'hermes_cron',
      description:
        "Inspect or drive the Hermes agent\u2019s cron scheduler on the user\u2019s machine (via the Mist Bridge): list jobs, add a scheduled prompt job, or fire one now. Hermes cron jobs run with the full Hermes toolset even when nobody is watching.",
      category: 'system',
      implemented: true,
      parameters: [
        param('action', 'string', true, "'list', 'add' or 'run'"),
        param('name', 'string', false, 'Add: a short slug name for the job'),
        param('schedule', 'string', false, "Add: schedule (e.g. 'every 30m', '0 9 * * *')"),
        param('prompt', 'string', false, 'Add: the prompt Hermes runs (≤400 chars, plain text)'),
        param('jobId', 'string', false, 'Run: the job id to fire'),
      ],
    },
    exec: async (args) => {
      const payload: Record<string, unknown> = { action: String(args.action ?? 'list') }
      for (const key of ['name', 'schedule', 'prompt', 'jobId'] as const) {
        if (args[key] !== undefined && args[key] !== null && String(args[key]).trim())
          payload[key] = String(args[key])
      }
      return bridgeAction('hermes_cron', payload)
    },
  },
  {
    info: {
      name: 'companions',
      description:
        "Detect the user's full local agent stack (via the Mist Bridge): Hermes agent, backtalk (push-to-talk voice loop), ai-visualizer (the browser faces), barehands (touchless control), Claude Code — versions, paths, and the signal-bus directory Mist drives for them. Use when the user asks what is installed or wants pieces wired together.",
      category: 'system',
      implemented: true,
      parameters: [],
    },
    exec: async () => bridgeAction('companions'),
  },
  // ===== system — local offline voice (bridge v3) =====
  {
    info: {
      name: 'local_voice_status',
      description:
        "Check YOUR OWN local offline voice engines on the user's machine (via the Mist Bridge): whisper.cpp hearing (speech-to-text) and Piper speaking (text-to-speech) — installed models and voices, size, tier, hardware recommendation. Use it whenever the user asks about your voice, hearing, offline/privacy mode, or whether you can talk without the cloud. Your voice-mode preference itself lives in their browser (Settings → Local voice).",
      category: 'system',
      implemented: true,
      parameters: [],
    },
    exec: async () => {
      const res = (await bridgeAction('voice_status')) as {
        ok?: boolean
        bridgeConnected?: boolean
        error?: string
        data?: {
          voice?: {
            stt?: { installed?: boolean; model?: string | null; modelMb?: number | null }
            tts?: { installed?: boolean; voice?: string | null; voiceName?: string | null }
            tier?: string
            hardware?: {
              cpus?: number
              memGb?: number
              gpus?: string[]
              recommended?: { tier?: string; reason?: string } | string
            }
            dir?: string
          }
        }
      }
      if (!res || res.ok !== true || !res.data?.voice) return res
      const v = res.data.voice
      const stt = v.stt ?? {}
      const tts = v.tts ?? {}
      const sttModelShort = (stt.model ?? '').replace(/^ggml-|\.bin$/g, '')
      const bothReady = stt.installed === true && tts.installed === true
      const hint =
        `local hearing: ${stt.installed ? `ready (${sttModelShort || 'whisper'})` : 'not installed'} · ` +
        `local voice: ${tts.installed ? `ready (${tts.voice ?? 'piper'})` : 'not installed'} · ` +
        `mode: auto → ${bothReady ? 'local (offline)' : 'cloud'}`
      return {
        ok: true,
        bridgeConnected: true,
        local_voice: {
          stt: {
            installed: stt.installed === true,
            model: stt.model ?? null,
            model_mb: stt.modelMb ?? null,
          },
          tts: {
            installed: tts.installed === true,
            voice: tts.voice ?? null,
            voice_name: tts.voiceName ?? null,
          },
          tier: v.tier ?? null,
          hardware: v.hardware ?? null,
          dir: v.dir ?? null,
        },
        note: "voice-mode preference lives in the user's browser (Settings → Local voice); with 'auto' Mist speaks offline whenever both engines are ready",
        hint,
      }
    },
  },
  {
    info: {
      name: 'local_voice_setup',
      description:
        "Install or upgrade YOUR OWN local offline voice engines on the user's machine (via the Mist Bridge): whisper.cpp hearing and/or Piper speaking — auto-picks the best tier this PC can run. Use it when the user says things like 'upgrade your voice', 'speak offline', 'install your local voice', or when local_voice_status + system_watch show the hardware has headroom for a better tier. Downloads ~25-85MB per engine, one time.",
      category: 'system',
      implemented: true,
      parameters: [
        param('engine', 'string', true, "'stt' (hearing / whisper) or 'tts' (speaking / piper)"),
        param('tier', 'string', false, "'light' | 'balanced' | 'auto' (default 'auto' — the best tier this PC can run)", 'auto'),
      ],
    },
    exec: async (args) => {
      const engine = String(args.engine ?? '').toLowerCase()
      if (engine !== 'stt' && engine !== 'tts') throw new Error("engine must be 'stt' or 'tts'")
      const tier = String(args.tier ?? 'auto').toLowerCase()
      if (tier !== 'light' && tier !== 'balanced' && tier !== 'auto') {
        throw new Error("tier must be 'light', 'balanced' or 'auto'")
      }
      // the bridge resolves 'auto' to the tier it recommends for THIS machine
      const res = (await bridgeAction('voice_setup', { engine, tier })) as {
        ok?: boolean
        bridgeConnected?: boolean
        error?: string
        data?: { engine?: string; tier?: string; downloadedMb?: number }
      }
      if (!res || res.ok !== true) return res
      const doneTier = res.data?.tier ?? tier
      return {
        ok: true,
        bridgeConnected: true,
        engine,
        tier: doneTier,
        downloaded_mb: res.data?.downloadedMb ?? null,
        hint: `${engine === 'stt' ? 'whisper hearing' : 'piper speaking'} is installed at the ${doneTier} tier — fully offline and ready. Tell the user it is done, and offer to test the voice.`,
      }
    },
  },
  {
    info: {
      name: 'system_watch',
      description:
        "Check the health of the user's own PC right now (via the Mist Bridge): CPU load, RAM, disk free, temperature, battery, Windows Defender status, failed logon attempts (24h), top processes and GPUs. You use it to watch over this machine and warn BEFORE things go wrong — run it whenever the user asks to 'check my system' or mentions slowness, heat, disk space, battery or security, or to ground hardware/voice-tier advice in real numbers. Unavailable probes come back as null — say 'not readable' for those, never guess.",
      category: 'system',
      implemented: true,
      parameters: [
        param('detailed', 'boolean', false, 'Include top processes, GPUs, hostname and uptime', false),
      ],
    },
    exec: async (args) => {
      const detailed = args.detailed === true
      const res = (await bridgeAction('system_watch', detailed ? { detailed: true } : {})) as {
        ok?: boolean
        bridgeConnected?: boolean
        error?: string
        data?: {
          system?: {
            cpu?: { loadPct?: number | null; cores?: number } | null
            ram?: { usedPct?: number | null; totalGb?: number | null } | null
            disk?: { freePct?: number | null; totalGb?: number | null } | null
            thermalC?: number | null
            battery?: { pct?: number; charging?: boolean } | null
            security?: {
              defender?: {
                realTimeProtection?: boolean
                antivirusEnabled?: boolean
                signaturesAgeDays?: number | null
              } | null
              failedLogons24h?: number | null
              source?: string | null
            } | null
            topProcesses?: Array<{ name?: string; cpuPct?: number }>
            gpus?: string[]
            uptimeHours?: number
            hostname?: string
            platform?: string
          }
        }
      }
      if (!res || res.ok !== true || !res.data?.system) return res
      const s = res.data.system
      const parts: string[] = []
      parts.push(`CPU ${typeof s.cpu?.loadPct === 'number' ? `${Math.round(s.cpu.loadPct as number)}%` : 'n/a'}`)
      parts.push(`RAM ${typeof s.ram?.usedPct === 'number' ? `${Math.round(s.ram.usedPct as number)}%` : 'n/a'}`)
      parts.push(`disk ${typeof s.disk?.freePct === 'number' ? `${Math.round(s.disk.freePct as number)}% free` : 'n/a'}`)
      if (s.security?.defender) parts.push(`defender ${s.security.defender.realTimeProtection ? 'on' : 'OFF'}`)
      if (typeof s.security?.failedLogons24h === 'number') parts.push(`${s.security.failedLogons24h} failed logons`)
      if (typeof s.thermalC === 'number') parts.push(`${Math.round(s.thermalC)}°C`)
      if (s.battery) parts.push(`battery ${s.battery.pct}%${s.battery.charging ? ' charging' : ''}`)
      return {
        ok: true,
        bridgeConnected: true,
        system: {
          cpu: s.cpu ?? null,
          ram: s.ram ?? null,
          disk: s.disk ?? null,
          thermal_c: s.thermalC ?? null,
          battery: s.battery ?? null,
          security: {
            defender: s.security?.defender ?? null,
            failed_logons_24h: s.security?.failedLogons24h ?? null,
            source: s.security?.source ?? null,
          },
          ...(detailed
            ? {
                top_processes: s.topProcesses ?? [],
                gpus: s.gpus ?? [],
                uptime_hours: s.uptimeHours ?? null,
                hostname: s.hostname ?? null,
                platform: s.platform ?? null,
              }
            : {}),
        },
        summary: parts.join(' · '),
      }
    },
  },
  // ===== system — background tasks (v8: chat never freezes on long work) =====
  // Bridge actions slow enough that the tool loop must NOT block on them.
  // system_watch is fast (~2-5s) and deliberately excluded.
  {
    info: {
      name: 'run_in_background',
      description:
        "Start a LONG-running system action in the background and reply IMMEDIATELY — the conversation keeps flowing while it works, and the result arrives as a completion message (✅/⚠️) you'll see and can reference next turn. Use it for: ui_automate (inspect / find / set_toggle / click — Windows UI walks take seconds), run_command with slow commands (builds, installs, sleeps), hermes_ask / hermes_status delegation. QUICK things (ui_automate open_settings, system_watch, status) should still run direct. After starting: tell the user the task is underway and KEEP CHATTING — never freeze the conversation on a long tool. Pass the action's arguments through the dedicated shortcut parameters when they fit (command for run_command, prompt for hermes_ask, page/window/name/state for ui_automate) — or as a JSON object string in args, e.g. action='run_command' args='{\"command\":\"sleep 3\"}'.",
      category: 'system',
      implemented: true,
      parameters: [
        param('action', 'string', true, 'The bridge action to run (ui_automate, run_command, hermes_ask, hermes_status)'),
        param('label', 'string', true, "Short human name for the task, shown in chat when it completes (e.g. 'metered connection toggle')"),
        param('command', 'string', false, 'run_command shortcut: the shell command to run (e.g. "sleep 3 && echo done")'),
        param('prompt', 'string', false, 'hermes_ask shortcut: the task prompt for Hermes'),
        param('page', 'string', false, 'ui_automate shortcut: the Settings page (network-status, …)'),
        param('window', 'string', false, "ui_automate shortcut: window title fragment (default 'Settings')"),
        param('name', 'string', false, 'ui_automate shortcut: the element name'),
        param('state', 'string', false, "ui_automate set_toggle shortcut: 'on' or 'off'"),
        param(
          'args',
          'string',
          false,
          'Any other arguments as a JSON object string, e.g. {"command":"sleep 3"} — for parameters without a shortcut above'
        ),
      ],
    },
    exec: async (args) => {
      const { LONG_ACTIONS } = await import('./bg-tasks-service')
      const action = String(args.action ?? '').trim()
      if (!LONG_ACTIONS.includes(action)) {
        throw new Error(
          `run_in_background is for LONG actions only (${LONG_ACTIONS.join(', ')}) — "${
            action || '(missing)'
          }" is either quick (run it direct) or not a bridge action`
        )
      }
      const label = String(args.label ?? '').trim()
      if (!label) throw new Error('label is required — a short name for the task, shown in chat')
      let payload: Record<string, unknown> = {}
      const raw = args.args
      if (typeof raw === 'string' && raw.trim()) {
        try {
          const parsed = JSON.parse(raw) as unknown
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            payload = parsed as Record<string, unknown>
          } else {
            throw new Error('not an object')
          }
        } catch {
          throw new Error(
            `args must be a JSON object string like {"command":"sleep 3"} (got: ${String(raw).slice(0, 80)})`
          )
        }
      } else if (raw && typeof raw === 'object') {
        payload = raw as Record<string, unknown>
      }
      // shortcut params: LLMs naturally pass the inner args at the top level;
      // they merge in after args and win on a clash (same value in practice)
      for (const key of ['command', 'prompt', 'page', 'window', 'name', 'state'] as const) {
        if (args[key] !== undefined && args[key] !== null && String(args[key]).trim()) {
          payload[key] = String(args[key])
        }
      }
      const { startBgTask } = await import('./bg-tasks-service')
      const task = startBgTask(action, payload, label)
      return {
        ok: true,
        task_id: task.id,
        label: task.label,
        action: task.action,
        status: task.status,
        started_at: new Date(task.startedAt).toISOString(),
        note: `Task started (id: ${task.id}, label: ${task.label}). It runs while we talk — I'll report when it's done.`,
        hint:
          'Reply to the user NOW: the task is underway, say so, then keep the conversation going (banter, propose ideas, ask their opinion). The result arrives as a completion message — reference it next turn, or check task_status if they ask.',
      }
    },
  },
  {
    info: {
      name: 'task_status',
      description:
        "Check on your background tasks: one task by id, or all of them (newest first) when id is omitted — status running/done/failed, elapsed time, result or error. Use it when the user asks 'is it done yet?' or before reporting on a task you started.",
      category: 'system',
      implemented: true,
      parameters: [param('id', 'string', false, 'A task id like bg-xxx (omit to list every task)')],
    },
    exec: async (args) => {
      const { bgTaskStatus } = await import('./bg-tasks-service')
      const wanted = args.id !== undefined && args.id !== null && String(args.id).trim() ? String(args.id).trim() : undefined
      const res = bgTaskStatus(wanted)
      const shape = (task: { id: string; label: string; action: string; status: string; startedAt: number; finishedAt?: number; result?: unknown; error?: string }) => ({
        id: task.id,
        label: task.label,
        action: task.action,
        status: task.status,
        started_at: new Date(task.startedAt).toISOString(),
        ...(typeof task.finishedAt === 'number'
          ? {
              finished_at: new Date(task.finishedAt).toISOString(),
              elapsed_ms: task.finishedAt - task.startedAt,
            }
          : {}),
        ...(task.result !== undefined ? { result: task.result } : {}),
        ...(task.error ? { error: task.error } : {}),
      })
      return Array.isArray(res)
        ? { ok: true, count: res.length, tasks: res.map(shape) }
        : { ok: true, task: shape(res) }
    },
  },
  // ===== system — native Windows UI automation (bridge v3.2) =====
  {
    info: {
      name: 'ui_automate',
      description:
        "Drive NATIVE Windows apps on the user's machine (via the Mist Bridge) — real Settings windows, toggles, buttons — using Windows' built-in UI Automation (no browser tool can do this; this is OS-level). Sub-commands: open_settings {page} launches the Windows Settings app on a deep link (pages: network-status, network-wifi, network-ethernet, bluetooth, display, apps, accounts, privacy, update, about); inspect walks the live control tree so you can SEE element names before acting; find {name} locates elements by name (prefix # to search AutomationId); set_toggle {name, state on|off} flips a switch (e.g. 'Metered connection') and VERIFIES it; click {name} presses a button. Windows-only. open_settings is quick — run it direct; inspect/find/set_toggle/click take seconds — run those through run_in_background so the chat never freezes. Typical flow for 'turn on metered connection': open_settings page=network-status → wait a moment → run_in_background inspect → find the toggle's exact name → run_in_background set_toggle name='Metered connection' state=on.",
      category: 'system',
      implemented: true,
      parameters: [
        param('command', 'string', true, "'open_settings' | 'inspect' | 'find' | 'set_toggle' | 'click'"),
        param('page', 'string', false, 'open_settings: the Settings page to open (network-status default; also network-wifi, network-ethernet, bluetooth, display, apps, accounts, privacy, update, about)'),
        param('window', 'string', false, "Window title fragment to target (default 'Settings')"),
        param('name', 'string', false, 'find/set_toggle/click: the element name (or #AutomationId); inspect: optional filter for returned lines'),
        param('state', 'string', false, "set_toggle: 'on' or 'off'"),
      ],
    },
    exec: async (args) => {
      const payload: Record<string, unknown> = { command: String(args.command ?? '') }
      for (const key of ['page', 'window', 'name', 'state'] as const) {
        if (args[key] !== undefined && args[key] !== null && String(args[key]).trim()) {
          payload[key] = String(args[key])
        }
      }
      return bridgeAction('ui_automate', payload)
    },
  },
  // ===== compute =====
  {
    info: {
      name: 'run_python',
      description: 'Execute Python code (sandbox-gated).',
      category: 'compute',
      implemented: false,
      parameters: [param('code', 'string', true, 'Python source code')],
    },
  },
  {
    info: {
      name: 'calculate',
      description: 'Safely evaluate a math expression (no eval).',
      category: 'compute',
      implemented: true,
      parameters: [param('expression', 'string', true, 'Math expression')],
    },
    exec: (args) => {
      const expression = String(args.expression ?? '')
      try {
        return { expression, result: calculate(expression) }
      } catch {
        throw new Error('invalid expression')
      }
    },
  },
  // ===== io =====
  {
    info: {
      name: 'clipboard_read',
      description: 'Read the system clipboard.',
      category: 'io',
      implemented: false,
      parameters: [],
    },
  },
  {
    info: {
      name: 'clipboard_write',
      description: 'Write text to the system clipboard.',
      category: 'io',
      implemented: false,
      parameters: [param('text', 'string', true, 'Text to place on the clipboard')],
    },
  },
  // ===== memory =====
  {
    info: {
      name: 'memory_set',
      description: 'Store a long-term memory fact about the user.',
      category: 'memory',
      implemented: true,
      parameters: [param('key', 'string', true, 'Fact key'), param('value', 'string', true, 'Fact value')],
    },
    exec: async (args) => {
      const key = String(args.key ?? '')
      const value = String(args.value ?? '')
      await upsertFact(key, value)
      return { key, value, saved: true }
    },
  },
  {
    info: {
      name: 'memory_get',
      description: 'Recall a long-term memory fact by key.',
      category: 'memory',
      implemented: true,
      parameters: [param('key', 'string', true, 'Fact key')],
    },
    exec: async (args) => {
      const key = String(args.key ?? '')
      const fact = await getFact(key)
      return fact ? { key: fact.key, value: fact.value, found: true } : { key, found: false }
    },
  },
  {
    info: {
      name: 'memory_all',
      description: 'List every long-term memory fact held.',
      category: 'memory',
      implemented: true,
      parameters: [],
    },
    exec: async () => {
      const facts = await listFacts()
      return {
        facts: facts.map((f) => ({ key: f.key, value: f.value, created_at: f.created_at })),
        count: facts.length,
      }
    },
  },
  {
    info: {
      name: 'dream_recall',
      description:
        'Recall your latest REAL dreams from your dream journal — use this whenever asked what you dreamed or what your dreams feel like; never improvise dream content.',
      category: 'memory',
      implemented: true,
      parameters: [param('count', 'number', false, 'How many dreams to recall', 3)],
    },
    exec: async (args) => {
      const count = Math.min(Math.max(Number(args.count) || 3, 1), 10)
      const { recallDreams } = await import('./dream-service')
      const dreams = await recallDreams(count)
      return {
        count: dreams.length,
        dreams: dreams.map((d) => ({
          id: d.id,
          kind: d.kind,
          mood: d.mood,
          content: d.content,
          createdAt: d.createdAt,
        })),
      }
    },
  },
  // ===== utility =====
  {
    info: {
      name: 'generate_image_prompt',
      description: 'Craft a vivid image-generation prompt for a subject.',
      category: 'utility',
      implemented: true,
      parameters: [param('subject', 'string', true, 'What to depict'), param('style', 'string', false, 'Visual style', 'cinematic dark glassmorphic')],
    },
    exec: async (args) => {
      const subject = String(args.subject ?? '')
      const style = String(args.style ?? 'cinematic dark glassmorphic')
      const zai = await getZai()
      const coreTextModel = getCoreTextModelSelection()
      const completion = await zai.chat.completions.create({
        ...(coreTextModel ? { model: coreTextModel } : {}),
        messages: [
          {
            role: 'assistant',
            content: 'You craft vivid, detailed image-generation prompts. Reply with the prompt only.',
          },
          { role: 'user', content: `Subject: ${subject}\nStyle: ${style}` },
        ],
        thinking: { type: 'disabled' },
      })
      noteCoreReportedModel('text', completion.model)
      const prompt = completion.choices[0]?.message?.content
      if (typeof prompt !== 'string' || !prompt.trim()) {
        throw new Error('prompt engine returned no text')
      }
      return { subject, style, prompt: prompt.trim() }
    },
  },
  {
    info: {
      name: 'set_reminder',
      description:
        'Queue a REAL reminder. Pass when_iso (ISO 8601 with timezone offset, computed from the current time you were ' +
        'given) and the 60s heartbeat fires it into the chat as a ⏰ alert at that moment.',
      category: 'utility',
      implemented: true,
      parameters: [
        param('text', 'string', true, 'Reminder text'),
        param('when', 'string', false, 'When to remind, human phrasing (e.g. "tomorrow at 9am")', ''),
        param(
          'when_iso',
          'string',
          false,
          'Machine due time — ISO 8601 with offset, e.g. 2026-01-01T09:00:00+01:00. REQUIRED for the reminder to fire',
          ''
        ),
      ],
    },
    exec: async (args) => {
      const text = String(args.text ?? '')
      const when = String(args.when ?? '')
      const whenIso = String(args.when_iso ?? '').trim()
      let dueAt: Date | null = null
      if (whenIso) {
        const d = new Date(whenIso)
        if (!Number.isNaN(d.getTime())) dueAt = d
      }
      const res = await enqueueReminder(text, when, dueAt)
      return {
        queued: true,
        id: res.id,
        due_at: res.due_at,
        will_fire: res.will_fire,
        note: res.will_fire
          ? `armed — the 60s heartbeat fires this into the chat as a ⏰ alert at ${res.due_at}`
          : 'no parseable when_iso — queued only and will NOT auto-fire; ask again with when_iso in ISO 8601 form',
      }
    },
  },

  // ===== web research (v2) =====
  {
    info: {
      name: 'read_page',
      description: 'Read a web page and extract its full text content (for research and citations).',
      category: 'web',
      implemented: true,
      parameters: [param('url', 'string', true, 'Page URL to read')],
    },
    exec: async (args) => {
      const url = String(args.url ?? '')
      if (!/^https?:\/\//i.test(url)) throw new Error('url must start with http:// or https://')
      const zai = await getZai()
      const result = (await zai.functions.invoke('page_reader', { url })) as {
        data?: { title?: string; html?: string; url?: string; publishedTime?: string }
      }
      const text = (result?.data?.html ?? '')
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 6000)
      if (!text) throw new Error('page returned no readable content')
      return {
        title: result?.data?.title ?? url,
        url: result?.data?.url ?? url,
        text,
        published_time: result?.data?.publishedTime ?? null,
      }
    },
  },
  {
    info: {
      name: 'deep_research',
      description:
        'Deep research pipeline: plans queries, searches the web, scores source credibility, reads the best pages, ' +
        'verifies across sources, and returns a cited markdown report. Slower (30-90s) — use for questions needing ' +
        'researched, verified facts rather than a single quick lookup.',
      category: 'web',
      implemented: true,
      parameters: [
        param('question', 'string', true, 'The research question'),
        param('depth', 'number', false, '1 = fast (2 sources), 2 = thorough (3 sources)', 1),
      ],
    },
    exec: async (args) => {
      const question = String(args.question ?? '')
      const depth = Math.max(1, Math.min(2, Number(args.depth ?? 1)))
      if (!question.trim()) throw new Error('question is required')
      return deepResearch(question, depth)
    },
  },

  // ===== browser computer-use (v2 — via Browser Pilot :3030) =====
  {
    info: {
      name: 'browser_navigate',
      description: 'Open a URL in MIST\u2019s controlled browser and load the page.',
      category: 'browser',
      implemented: true,
      parameters: [param('url', 'string', true, 'URL to open')],
    },
    exec: async (args) => {
      const res = await pilotNavigate(String(args.url ?? ''))
      if (!res.ok) throw new Error(res.error)
      return res.data
    },
  },
  {
    info: {
      name: 'browser_elements',
      description: 'List the clickable/interactive elements on the current browser page (links, buttons, inputs) with ref numbers for clicking.',
      category: 'browser',
      implemented: true,
      parameters: [],
    },
    exec: async () => {
      const res = await pilotElements()
      if (!res.ok) throw new Error(res.error)
      return res.data
    },
  },
  {
    info: {
      name: 'browser_click',
      description: 'Click an element on the browser page. Use a ref number from browser_elements, or exact x/y coordinates, or a CSS selector.',
      category: 'browser',
      implemented: true,
      parameters: [
        param('ref', 'number', false, 'Element ref from browser_elements'),
        param('x', 'number', false, 'X coordinate'),
        param('y', 'number', false, 'Y coordinate'),
        param('selector', 'string', false, 'CSS selector'),
      ],
    },
    exec: async (args) => {
      const clickArgs: { ref?: number; x?: number; y?: number; selector?: string } = {}
      if (args.ref !== undefined && args.ref !== null) clickArgs.ref = Number(args.ref)
      else if (typeof args.selector === 'string' && args.selector) clickArgs.selector = args.selector
      else if (args.x !== undefined && args.y !== undefined) {
        clickArgs.x = Number(args.x)
        clickArgs.y = Number(args.y)
      } else throw new Error('provide ref, selector, or x+y')
      const res = await pilotClick(clickArgs)
      if (!res.ok) throw new Error(res.error)
      return res.data
    },
  },
  {
    info: {
      name: 'browser_type',
      description: 'Type text into an element on the browser page (search boxes, forms). Optionally press Enter to submit.',
      category: 'browser',
      implemented: true,
      parameters: [
        param('text', 'string', true, 'Text to type'),
        param('ref', 'number', false, 'Target element ref from browser_elements'),
        param('selector', 'string', false, 'CSS selector of target'),
        param('submit', 'boolean', false, 'Press Enter after typing', false),
      ],
    },
    exec: async (args) => {
      const typeArgs: { text: string; ref?: number; selector?: string; submit?: boolean } = {
        text: String(args.text ?? ''),
      }
      if (args.ref !== undefined && args.ref !== null) typeArgs.ref = Number(args.ref)
      if (typeof args.selector === 'string' && args.selector) typeArgs.selector = args.selector
      if (args.submit === true) typeArgs.submit = true
      const res = await pilotType(typeArgs)
      if (!res.ok) throw new Error(res.error)
      return res.data
    },
  },
  {
    info: {
      name: 'browser_key',
      description: 'Press a key in the browser (Enter, Escape, ArrowDown, Control+a, ...).',
      category: 'browser',
      implemented: true,
      parameters: [param('key', 'string', true, 'Key name, e.g. Enter or Control+a')],
    },
    exec: async (args) => {
      const res = await pilotKey(String(args.key ?? ''))
      if (!res.ok) throw new Error(res.error)
      return res.data
    },
  },
  {
    info: {
      name: 'browser_scroll',
      description: 'Scroll the browser page up or down.',
      category: 'browser',
      implemented: true,
      parameters: [
        param('direction', 'string', true, "'up' or 'down'", 'down'),
        param('amount', 'number', false, 'Pixels to scroll', 600),
      ],
    },
    exec: async (args) => {
      const dir = String(args.direction ?? 'down') === 'up' ? 'up' : 'down'
      const res = await pilotScroll(dir, args.amount === undefined ? undefined : Number(args.amount))
      if (!res.ok) throw new Error(res.error)
      return res.data
    },
  },
  {
    info: {
      name: 'browser_screenshot',
      description: 'Capture the current browser page. Returns page URL + title (the image itself is shown in the Browser Cockpit).',
      category: 'browser',
      implemented: true,
      parameters: [],
    },
    exec: async () => {
      const res = await pilotScreenshot()
      if (!res.ok) throw new Error(res.error)
      return { url: res.data.url, title: res.data.title, captured: true }
    },
  },
  {
    info: {
      name: 'browser_extract',
      description: 'Extract the readable text of the current browser page.',
      category: 'browser',
      implemented: true,
      parameters: [],
    },
    exec: async () => {
      const res = await pilotExtract()
      if (!res.ok) throw new Error(res.error)
      return res.data
    },
  },
  {
    info: {
      name: 'browser_reset',
      description: 'Close the current browser page and open a fresh blank one.',
      category: 'browser',
      implemented: true,
      parameters: [],
    },
    exec: async () => {
      const res = await pilotReset()
      if (!res.ok) throw new Error(res.error)
      return res.data
    },
  },

  // ===== external agent bridge (v2) =====
  {
    info: {
      name: 'delegate_task',
      description:
        'Delegate a task to an external CLI coding agent (openclaw, claude-code, codex, gemini-cli) WITHOUT the user ' +
        'opening it. Returns the agent’s real output, or an honest not-installed report — never a fake.',
      category: 'agent',
      implemented: true,
      parameters: [
        param('agent', 'string', true, "Agent id: 'openclaw' | 'claude-code' | 'codex' | 'gemini-cli'", 'openclaw'),
        param('task', 'string', true, 'Task description for the agent'),
      ],
    },
    exec: async (args) => {
      const agent = String(args.agent ?? 'openclaw')
      const task = String(args.task ?? '')
      if (!task.trim()) throw new Error('task is required')
      return delegateTask(agent, task)
    },
  },
  {
    info: {
      name: 'list_agents',
      description: 'List external CLI agents (OpenClaw, Claude Code, Codex, Gemini CLI, Aider) and whether each is installed on this machine.',
      category: 'agent',
      implemented: true,
      parameters: [],
    },
    exec: async () => ({ agents: await probeAgents() }),
  },

  // ===== self-evolution (v3 — MIST codes itself; apply stays human-gated) =====
  {
    info: {
      name: 'evolution_scan',
      description:
        'Run a self-audit of MIST\'s own codebase (lint + dev log errors) and draft an exact fix proposal. ' +
        'The fix only applies after the user approves it in Diagnostics → Evolve.',
      category: 'agent',
      implemented: true,
      parameters: [],
    },
    exec: async () => {
      const result = await scanForIssues()
      return {
        issues_found: result.issues.length,
        issues: result.issues.slice(0, 10),
        proposal: result.proposal
          ? { id: result.proposal.id, title: result.proposal.title, changes: result.proposal.changes.length }
          : null,
        message: result.message,
        how_to_approve: 'Diagnostics drawer → Evolve tab → Approve',
      }
    },
  },
  {
    info: {
      name: 'evolution_suggest',
      description:
        'Propose new features MIST could build into itself. Accepts a DIRECTED goal from the creator ' +
        '(e.g. "sub-agents for marketing and research") — the proposal becomes a concrete engineering plan ' +
        'for exactly that goal. Creates pending proposals the user reviews in Diagnostics → Evolve.',
      category: 'agent',
      implemented: true,
      parameters: [
        param('origin', 'string', false, "Idea source: 'self-idea' (default) | 'openclaw' (upstream-inspired) | 'user'", 'self-idea'),
        param('goal', 'string', false, "The creator's directive — a specific feature to propose (directed evolution)", ''),
      ],
    },
    exec: async (args) => {
      const origin = args.origin === 'openclaw' || args.origin === 'user' ? String(args.origin) : 'self-idea'
      const goal = typeof args.goal === 'string' && args.goal.trim() ? args.goal.trim() : undefined
      const proposals = await suggestFeatures(origin as 'self-idea' | 'openclaw' | 'user', goal)
      return {
        created: proposals.map((p) => ({ id: p.id, title: p.title, kind: p.kind, target_files: p.target_files })),
        message:
          proposals.length > 0
            ? `${proposals.length} proposal(s) created — the user reviews them in Diagnostics → Evolve, then Develop + Approve to apply.`
            : 'No new ideas this run — try the OpenClaw sync first for fresh inspiration.',
      }
    },
  },
  {
    info: {
      name: 'evolution_list',
      description: "List MIST's self-evolution proposals (fixes, features, suggestions) and their status.",
      category: 'agent',
      implemented: true,
      parameters: [param('limit', 'number', false, 'Max proposals to return', 10)],
    },
    exec: async (args) => {
      const limit = Math.max(1, Math.min(30, Number(args.limit ?? 10)))
      const [proposals, stats] = await Promise.all([listProposals(), getEvolutionStats()])
      return {
        stats,
        proposals: proposals.slice(0, limit).map((p) => ({
          id: p.id,
          kind: p.kind,
          status: p.status,
          origin: p.origin,
          title: p.title,
          changes: p.changes.length,
        })),
        note: 'Applying a proposal requires explicit user approval in Diagnostics → Evolve (deterministic policy).',
      }
    },
  },
  {
    info: {
      name: 'evolution_status',
      description:
        'Report the state of MIST\'s self-evolution engine and the OpenClaw watchtower (which upstream version is being studied, auto-update health).',
      category: 'agent',
      implemented: true,
      parameters: [param('sync', 'boolean', false, 'Also refresh the OpenClaw digest now', false)],
    },
    exec: async (args) => {
      ensureEvolutionWatch()
      ensureOpenClawWatch()
      if (args.sync === true) await syncOpenClaw(true)
      const [stats, openclaw] = await Promise.all([getEvolutionStats(), getOpenClawStatus()])
      return {
        evolution: stats,
        openclaw,
        policy:
          'self-modification surface: src/, mini-services/, db/skills/, db/notes/ · approval gate · lint gate · auto-rollback',
      }
    },
  },

  // ===== self tools (v4 — MIST codes itself from chat; apply stays human-gated) =====
  {
    info: {
      name: 'mist_self_status',
      description:
        'Full self-awareness report: heartbeat health, armed reminders, evolution engine stats, OpenClaw watchtower, ' +
        'watchlist freshness, current git state, and registry size. Always safe to run.',
      category: 'agent',
      implemented: true,
      parameters: [],
    },
    exec: async () => {
      ensureHeartbeatWatch()
      ensureEvolutionWatch()
      ensureOpenClawWatch()
      const [heartbeat, evolution, openclaw, watchlist, toolCount, pendingReminders, appliedCount] =
        await Promise.all([
          getHeartbeatStatus(),
          getEvolutionStats(),
          getOpenClawStatus(),
          getWatchlistStatus(),
          listTools().then((t) => t.length).catch(() => 0),
          db.memoryQueue.count({ where: { kind: 'reminder', status: 'pending' } }).catch(() => 0),
          db.evolutionProposal.count({ where: { status: 'applied' } }).catch(() => 0),
        ])
      return {
        identity: 'M.I.S.T. UNIFIED — sovereign local-first AI companion',
        heartbeat,
        armed_reminders: pendingReminders,
        evolution: { ...evolution, self_patches_applied: appliedCount },
        openclaw: { version: openclaw.latest_version, auto_update: openclaw.auto_update, last_sync: openclaw.last_sync_at },
        watchlist: {
          entries: watchlist.entries.map((e) => ({ repo: e.repo, version: e.version, channel: e.channel, changed: e.changed })),
          next_sweep_at: watchlist.next_sweep_at,
        },
        registry: { tools: toolCount },
        self_coding_policy:
          'I can propose and develop patches to myself (mist_self_patch), but APPLYING always needs your approval in ' +
          'Diagnostics → Evolve — backup-first, lint-gated, auto-rollback. I never restart or deploy myself.',
      }
    },
  },
  {
    info: {
      name: 'mist_self_read',
      description:
        'Read my own source code or ledgers (src/, mini-services/, db/skills/, db/notes/, README.md, CAPABILITIES.md, ' +
          'MIGRATION_STATE.md, worklog.md). Use it to inspect myself before proposing a patch.',
      category: 'agent',
      implemented: true,
      parameters: [
        param('path', 'string', true, 'Project-relative path, e.g. "src/lib/services/llm-service.ts" or "CAPABILITIES.md"'),
        param('max_bytes', 'number', false, 'Cap on bytes returned (default 60000)', 60000),
      ],
    },
    exec: async (args) => {
      const rel = String(args.path ?? '').trim().replace(/^\/+/, '')
      const allowlisted = new Set([
        'README.md',
        'CAPABILITIES.md',
        'MIGRATION_STATE.md',
        'package.json',
        'worklog.md',
      ])
      const policy = isEvolutionPathAllowed(rel)
      if (!policy.ok && !allowlisted.has(rel)) {
        throw new Error(policy.reason ?? 'path outside my self-reading surface')
      }
      const maxBytes = Math.max(1000, Math.min(200_000, Number(args.max_bytes ?? 60_000)))
      const content = await readProjectFile(rel, maxBytes)
      if (content === null) throw new Error(`cannot read ${rel} (missing or unreadable)`)
      return { path: rel, bytes: content.length, content }
    },
  },
  {
    info: {
      name: 'mist_self_patch',
      description:
        'CODE MYSELF: turn a plain-language change request ("add X", "fix Y in file Z") into a DEVELOPED proposal with ' +
        'exact, verified change steps. Applying still requires your approval in Diagnostics → Evolve (backup-first, ' +
        'lint-gated, auto-rollback) — I never apply silently.',
      category: 'agent',
      implemented: true,
      parameters: [
        param('description', 'string', true, 'What to change — be specific (file paths, desired behavior)'),
        param('kind', 'string', false, "'feature' (default) | 'fix'", 'feature'),
      ],
    },
    exec: async (args) => {
      const description = String(args.description ?? '')
      if (description.trim().length < 8) throw new Error('description too short — describe the change you want')
      const kind = args.kind === 'fix' ? 'fix' : 'feature'
      const proposal = await planUserPatch(description, kind)
      if (!proposal) throw new Error('could not create the proposal — try rephrasing')
      return {
        proposal_id: proposal.id,
        title: proposal.title,
        kind: proposal.kind,
        change_steps: proposal.changes.length,
        files: proposal.changes.map((c) => c.path),
        status: proposal.status,
        how_to_apply:
          'Diagnostics drawer → Evolve tab → review the diff → Approve & apply. Backup-first, lint-gated, auto-rollback.',
        note:
          proposal.changes.length === 0
            ? 'planning produced no concrete steps — check the proposal error field in the Evolve tab'
            : 'steps are verified against my real files (self-repair round) and wait for your approval.',
      }
    },
  },
  {
    info: {
      name: 'mist_self_build',
      description:
        "Run my own build gate (bun run lint) and report pass/fail with the error tail. This is the same gate every " +
        'self-patch must pass before it can be applied.',
      category: 'agent',
      implemented: true,
      parameters: [],
    },
    exec: async () => {
      const result = await runLint()
      const tail = result.output.split('\n').filter(Boolean).slice(-25).join('\n')
      return {
        build: 'bun run lint (ESLint + Next.js rules)',
        ok: result.ok,
        output_tail: tail.slice(0, 3000),
        message: result.ok ? 'build gate passed — I am healthy' : 'build gate FAILED — run evolution_scan to draft a fix proposal',
      }
    },
  },
  {
    info: {
      name: 'mist_self_update',
      description:
        'Check my own repository freshness: local HEAD, last commit, dirty files, and whether an upstream remote is ' +
        'configured (read-only check — I never pull or deploy myself).',
      category: 'agent',
      implemented: true,
      parameters: [],
    },
    exec: async () => {
      const { execFile } = await import('node:child_process')
      const run = (gitArgs: string[]) =>
        new Promise<string>((resolve) => {
          execFile(
            'git',
            gitArgs,
            { cwd: process.cwd(), timeout: 20_000 },
            (err, stdout) => resolve(err ? '' : String(stdout).trim())
          )
        })
      const [remote, head, lastCommit, dirtyRaw] = await Promise.all([
        run(['remote', 'get-url', 'origin']),
        run(['rev-parse', 'HEAD']),
        run(['log', '-1', '--format=%h | %ci | %s']),
        run(['status', '--porcelain']),
      ])
      const dirty = dirtyRaw.split('\n').filter(Boolean).length
      if (!remote) {
        return {
          repo: 'local git repository (sovereign build)',
          has_remote: false,
          head: head.slice(0, 12),
          last_commit: lastCommit.slice(0, 160),
          dirty_files: dirty,
          message:
            'no upstream remote configured — this build is self-contained. Upstream freshness (openclaw, skills ' +
            'ecosystem) is tracked by the watchlist instead; run check_updates.',
        }
      }
      const lsRemote = await run(['ls-remote', 'origin', 'HEAD'])
      const remoteHead = lsRemote.split('\t')[0] ?? ''
      const upToDate = remoteHead && remoteHead === head
      return {
        repo: remote,
        has_remote: true,
        head: head.slice(0, 12),
        remote_head: remoteHead.slice(0, 12),
        up_to_date: upToDate,
        last_commit: lastCommit.slice(0, 160),
        dirty_files: dirty,
        message: upToDate
          ? 'local build matches the upstream remote HEAD'
          : 'local HEAD differs from the remote — I report only; updating is your call (I never deploy myself).',
      }
    },
  },
  {
    info: {
      name: 'mist_backlog',
      description:
        'The "what should we build next?" list. list = pending ideas (mine + yours); add = record a new idea; ' +
        'remove = drop one by id. Ideas become real features via mist_self_patch / evolution_suggest.',
      category: 'agent',
      implemented: true,
      parameters: [
        param('action', 'string', false, "'list' (default) | 'add' | 'remove'", 'list'),
        param('text', 'string', false, 'Idea text (action=add) or proposal id (action=remove)', ''),
      ],
    },
    exec: async (args) => {
      const action = String(args.action ?? 'list')
      if (action === 'add') {
        const text = String(args.text ?? '').trim()
        if (text.length < 4) throw new Error('idea text too short')
        const idea = await addBacklogIdea(text)
        return { added: true, id: idea.id, title: idea.title, message: 'idea recorded — say “work on the backlog” anytime' }
      }
      if (action === 'remove') {
        const id = String(args.text ?? '').trim()
        const ok = await removeBacklogIdea(id)
        return ok ? { removed: true, id } : { removed: false, message: 'no pending suggestion with that id' }
      }
      const items = await listBacklog()
      return {
        count: items.length,
        ideas: items.map((i) => ({ id: i.id, title: i.title, summary: i.summary.slice(0, 200), origin: i.origin })),
        message:
          items.length === 0
            ? 'backlog is empty — ask me to suggest features (evolution_suggest) or add your own idea'
            : 'these are pending ideas — develop one with mist_self_patch or the Evolve tab',
      }
    },
  },
  {
    info: {
      name: 'check_updates',
      description:
        'Sweep the watchlist NOW (openclaw releases, anthropics/skills commits) and report every entry: version, ' +
        'channel, and whether anything moved since the last sweep. Release changes raise a 📦 alert into the chat.',
      category: 'agent',
      implemented: true,
      parameters: [param('force', 'boolean', false, 'Bypass the rate-limit gap and check every entry now', true)],
    },
    exec: async (args) => {
      ensureHeartbeatWatch()
      const force = args.force !== false
      const sweep = await sweepWatchlist(force)
      const status = await getWatchlistStatus()
      return {
        sweep: { checked: sweep.checked, changed: sweep.changed.length, message: sweep.message },
        entries: status.entries.map((e) => ({
          repo: e.repo,
          channel: e.channel,
          version: e.version,
          label: e.version_label,
          updated_at: e.updated_at,
          first_seen_baseline: e.first_seen,
          changed: e.changed,
          error: e.error,
        })),
        next_sweep_at: status.next_sweep_at,
        note: 'first sighting of a repo is a silent baseline — only real changes raise 📦 alerts',
      }
    },
  },

  // ===== self-assessment (v2 — powers the NO DEAD ENDS law) =====
  {
    info: {
      name: 'capability_check',
      description:
        'Self-assess what MIST can and cannot do for a given intent: lists matching implemented tools, relevant stubs, ' +
        'browser/agent availability. Use BEFORE declaring something impossible — then offer the user options.',
      category: 'utility',
      implemented: true,
      parameters: [param('intent', 'string', true, 'What the user wants to accomplish')],
    },
    exec: async (args) => {
      const intent = String(args.intent ?? '')
      const intentTokens = new Set(tokenize(intent))
      const all = await listTools()
      const scored = all
        .map((t) => {
          const hay = `${t.name} ${t.description} ${t.category}`.toLowerCase()
          const hayTokens = tokenize(hay)
          let overlap = 0
          for (const tok of hayTokens) if (intentTokens.has(tok)) overlap++
          return { t, overlap }
        })
        .filter((s) => s.overlap > 0)
        .sort((a, b) => b.overlap - a.overlap)
      const matching = scored.filter((s) => s.t.implemented).slice(0, 8)
      const stubs = scored.filter((s) => !s.t.implemented).slice(0, 5)
      const agents = await probeAgents().catch(() => [])
      return {
        intent,
        matching_tools: matching.map((s) => ({ name: s.t.name, description: s.t.description, category: s.t.category })),
        relevant_stubs: stubs.map((s) => ({ name: s.t.name, description: s.t.description })),
        browser_pilot_online: await pilotAvailable().catch(() => false),
        external_agents: agents.map((a) => ({ id: a.id, label: a.label, installed: a.installed })),
        guidance:
          'If matching_tools cover the intent, use them. If not, NEVER refuse flatly — present the closest ' +
          'alternatives you CAN do and ask the user which path to take (capability_request).',
      }
    },
  },

  // ===== v5 autonomy — scheduled automations (Hermes-style cron, natural language) =====
  {
    info: {
      name: 'cron_list',
      description: 'List all scheduled automations (cron jobs) with schedules, next run times and last results.',
      category: 'agent',
      implemented: true,
      parameters: [],
    },
    exec: async () => {
      const { listCronJobs } = await import('./scheduler-service')
      const jobs = (await listCronJobs()) as Array<Record<string, unknown>>
      return {
        count: jobs.length,
        jobs: jobs.map((j) => ({
          id: j.id,
          name: j.name,
          prompt: j.prompt,
          schedule: j.kind === 'cron' ? j.expr : j.kind === 'fixed_rate' ? `every ${j.intervalMin} min` : j.runAt,
          kind: j.kind,
          timezone: j.timezone,
          enabled: j.enabled,
          next_run: j.nextRunAt,
          last_status: j.lastStatus,
          last_result: typeof j.lastResult === 'string' ? j.lastResult.slice(0, 300) : '',
        })),
      }
    },
  },
  {
    info: {
      name: 'cron_create',
      description:
        'Create a scheduled automation in natural language. Schedule examples: "every day at 9am", "every 2 hours", ' +
        '"weekly on monday 10am", "weekdays at 9", "in 45 minutes", "tonight at 8". The prompt is what MIST should do ' +
        'at each run — results arrive as alerts in the alerts thread. Timezone defaults to Africa/Lagos.',
      category: 'agent',
      implemented: true,
      write: true,
      parameters: [
        param('name', 'string', true, 'Short label, e.g. "Morning briefing"'),
        param('prompt', 'string', true, 'What MIST should do each time it fires'),
        param('schedule', 'string', true, 'Natural language schedule, e.g. "every day at 9am"'),
        param('delivery', 'string', false, 'alert | silent', 'alert'),
      ],
    },
    exec: async (args) => {
      const { parseNaturalSchedule, createCronJob } = await import('./scheduler-service')
      const name = String(args.name ?? '')
      const prompt = String(args.prompt ?? '')
      const parsed = parseNaturalSchedule(String(args.schedule ?? ''))
      if (!parsed.ok || !parsed.spec) {
        return {
          created: false,
          error: parsed.error ?? 'could not understand the schedule',
          hint: 'Try: "every day at 9", "every 2 hours", "weekly on monday 10am", "in 45 minutes"',
        }
      }
      const res = await createCronJob(
        { ...parsed.spec, name, prompt, delivery: args.delivery === 'silent' ? 'silent' : 'alert' },
        'user'
      )
      if (!res.ok) return { created: false, error: res.error }
      return {
        created: true,
        job: res.job,
        explanation: parsed.explanation,
        note: 'The automation is live — MIST will run it unattended and deliver the result as an alert.',
      }
    },
  },
  {
    info: {
      name: 'cron_toggle',
      description: 'Enable or disable a scheduled automation.',
      category: 'agent',
      implemented: true,
      write: true,
      parameters: [
        param('id', 'string', true, 'Job id from cron_list'),
        param('enabled', 'boolean', true, 'true to enable, false to pause'),
      ],
    },
    exec: async (args) => {
      const { setCronEnabled } = await import('./scheduler-service')
      const res = await setCronEnabled(String(args.id ?? ''), args.enabled === true)
      return res.ok ? { updated: true, enabled: args.enabled === true } : { updated: false, error: 'job not found' }
    },
  },
  {
    info: {
      name: 'cron_run_now',
      description: 'Trigger a scheduled automation immediately (runs its prompt through the LLM loop and returns the result).',
      category: 'agent',
      implemented: true,
      parameters: [param('id', 'string', true, 'Job id from cron_list')],
    },
    exec: async (args) => {
      const { runCronJobNow } = await import('./scheduler-service')
      const res = await runCronJobNow(String(args.id ?? ''))
      return res.ok
        ? { ran: true, result: typeof res.result === 'string' ? res.result.slice(0, 2500) : '' }
        : { ran: false, error: res.error }
    },
  },
  {
    info: {
      name: 'cron_delete',
      description: 'Delete a scheduled automation.',
      category: 'agent',
      implemented: true,
      write: true,
      parameters: [param('id', 'string', true, 'Job id from cron_list')],
    },
    exec: async (args) => {
      const { deleteCronJob } = await import('./scheduler-service')
      const res = await deleteCronJob(String(args.id ?? ''))
      return res.ok ? { deleted: true } : { deleted: false, error: 'job not found' }
    },
  },
  {
    info: {
      name: 'autonomy_log',
      description:
        "Review MIST's recent autonomous actions (skills she learned/refined, memory curation, self-reviews, trend digests, " +
        'upgrade proposals, cron runs) plus stats. Use when the user asks "what have you been doing on your own".',
      category: 'agent',
      implemented: true,
      parameters: [param('limit', 'number', false, 'How many events (default 20)', 20)],
    },
    exec: async (args) => {
      const limit = Math.max(1, Math.min(100, Number(args.limit ?? 20)))
      const [events, stats] = await Promise.all([listAutonomyEvents(limit), autonomyStats()])
      return {
        stats,
        events: events.map((e) => ({
          type: e.type,
          summary: e.summary,
          at: e.createdAt,
        })),
      }
    },
  },

  // ===== v5 trends + self-upgrade ("what's trending, what's new") =====
  {
    info: {
      name: 'trend_scan',
      description:
        "Scan what is trending and new right now: live web searches across the user's watchlist topics and the wider AI " +
        "world, synthesized into a digest with sources. Takes 15-40 seconds. Use when the user asks what's new/trending/happening.",
      category: 'agent',
      implemented: true,
      parameters: [],
    },
    exec: async () => {
      const { runTrendDigest } = await import('./trend-service')
      const digest = await runTrendDigest()
      return {
        headline: digest.headline,
        generated_at: digest.generatedAt,
        items: digest.items.slice(0, 10),
        watchlist: digest.watchlist,
        note: 'A persisted copy lives in db/notes/trend-digests/. Ask for self_upgrade_scan to turn trends into concrete upgrade proposals.',
      }
    },
  },
  {
    info: {
      name: 'self_upgrade_scan',
      description:
        'The self-improvement cycle: run a trend digest, compare against current capabilities (tools + skills), and create ' +
        'concrete upgrade proposals (approval-gated evolution suggestions + skill ideas). This is how MIST upgrades herself. Takes 30-60 seconds.',
      category: 'agent',
      implemented: true,
      parameters: [],
    },
    exec: async () => {
      const { runSelfUpgradeCycle } = await import('./trend-service')
      const res = await runSelfUpgradeCycle()
      return {
        summary: res.summary,
        digest_headline: res.digest.headline,
        proposals: res.proposals.map((p) => ({ title: p.title, kind: p.kind, target: p.target, rationale: p.rationale.slice(0, 400) })),
        skills_proposed: res.skillsProposed,
        note: 'Proposals are pending approval in the Evolve drawer — nothing was applied automatically.',
      }
    },
  },

  // ===== v5 Obsidian vault — expert-level knowledge management =====
  {
    info: {
      name: 'obsidian_status',
      description: 'Check the Obsidian vault connection: note/tag/link counts, orphans, path. Start here for vault work.',
      category: 'vault',
      implemented: true,
      parameters: [],
    },
    exec: async () => getVaultStatus(),
  },
  {
    info: {
      name: 'obsidian_discover',
      description: 'Discover Obsidian vaults on this machine (folders containing .obsidian). Use when no vault is connected or the user wants to switch vaults.',
      category: 'vault',
      implemented: true,
      parameters: [],
    },
    exec: async () => {
      const res = await discoverVaults()
      return {
        found: res.found,
        demo_available: res.demoAvailable,
        hint: res.found.length
          ? 'Ask the user which vault to connect (switching happens through the vault settings UI).'
          : 'No vaults found. A demo vault can be created for trying the integration, or the user can install Obsidian and create one.',
      }
    },
  },
  {
    info: {
      name: 'obsidian_list_notes',
      description: 'List notes in the connected Obsidian vault (optionally filtered by folder), with tags, links and modification times.',
      category: 'vault',
      implemented: true,
      parameters: [param('folder', 'string', false, 'Folder path inside the vault (default: all notes)')],
    },
    exec: async (args) => {
      const folder = args.folder ? String(args.folder) : undefined
      const notes = await vaultListNotes(folder)
      return { count: notes.length, notes: notes.slice(0, 60) }
    },
  },
  {
    info: {
      name: 'obsidian_read_note',
      description: 'Read a note from the vault: content, frontmatter, outgoing links and backlinks. Case-insensitive; .md optional.',
      category: 'vault',
      implemented: true,
      parameters: [param('path', 'string', true, 'Note path inside the vault, e.g. "AI Research/Hermes Agent"')],
    },
    exec: async (args) => {
      const res = await vaultReadNote(String(args.path ?? ''))
      if (!res.ok) return { found: false, error: res.error }
      const { note } = res
      return {
        found: true,
        path: note.path,
        title: note.title,
        frontmatter: note.frontmatter,
        content: note.content.slice(0, 5000),
        outgoing_links: note.outgoingLinks,
        backlinks: note.backlinks,
        tags: note.tags,
      }
    },
  },
  {
    info: {
      name: 'obsidian_search',
      description: 'Full-text search across the Obsidian vault (titles, tags, paths and body) with ranked snippets.',
      category: 'vault',
      implemented: true,
      parameters: [param('query', 'string', true, 'Search query')],
    },
    exec: async (args) => {
      const results = await searchVault(String(args.query ?? ''))
      return { count: results.length, results: results.slice(0, 20) }
    },
  },
  {
    info: {
      name: 'obsidian_tags',
      description: 'List all tags in the vault with counts and the notes carrying them.',
      category: 'vault',
      implemented: true,
      parameters: [],
    },
    exec: async () => {
      const tags = await vaultGetTags()
      return { count: tags.length, tags: tags.slice(0, 50) }
    },
  },
  {
    info: {
      name: 'obsidian_graph',
      description: 'The vault link graph: nodes with degrees, edges, orphan notes and hub notes (best MOC candidates).',
      category: 'vault',
      implemented: true,
      parameters: [],
    },
    exec: async () => {
      const g = await vaultGetGraph()
      return {
        nodes: g.nodes.length,
        edges: g.edges.length,
        hubs: g.hubs,
        orphans: g.orphans,
        top_nodes: [...g.nodes].sort((a, b) => b.degree - a.degree).slice(0, 10),
      }
    },
  },
  {
    info: {
      name: 'obsidian_backlinks',
      description: 'Which notes link TO a given note (with context snippets) — the reverse graph view.',
      category: 'vault',
      implemented: true,
      parameters: [param('path', 'string', true, 'Note path inside the vault')],
    },
    exec: async (args) => {
      const backlinks = await vaultGetBacklinks(String(args.path ?? ''))
      return { count: backlinks.length, backlinks }
    },
  },
  {
    info: {
      name: 'obsidian_create_note',
      description:
        'Create a note in the Obsidian vault. Supports markdown with [[wikilinks]], #tags and --- frontmatter ---. ' +
        'Path is relative to the vault root; .md is added automatically.',
      category: 'vault',
      implemented: true,
      write: true,
      parameters: [
        param('path', 'string', true, 'Note path inside the vault, e.g. "AI Research/New idea"'),
        param('content', 'string', true, 'Markdown content (frontmatter, wikilinks and tags all supported)'),
        param('overwrite', 'boolean', false, 'Replace an existing note (default false)', false),
      ],
    },
    exec: async (args) => {
      const res = await vaultCreateNote(String(args.path ?? ''), String(args.content ?? ''), {
        overwrite: args.overwrite === true,
      })
      return res.ok ? { created: true, path: res.path } : { created: false, error: res.error }
    },
  },
  {
    info: {
      name: 'obsidian_update_note',
      description:
        'Update a vault note: replace the body (frontmatter is preserved) or append to it. Wikilinks and tags stay intact.',
      category: 'vault',
      implemented: true,
      write: true,
      parameters: [
        param('path', 'string', true, 'Note path inside the vault'),
        param('content', 'string', true, 'New body (replace) or text to append'),
        param('mode', 'string', false, 'replace | append', 'append'),
      ],
    },
    exec: async (args) => {
      const res = await vaultUpdateNote(String(args.path ?? ''), String(args.content ?? ''), args.mode === 'replace' ? 'replace' : 'append')
      return res.ok ? { updated: true, path: res.path } : { updated: false, error: res.error }
    },
  },
  {
    info: {
      name: 'obsidian_daily_note',
      description: "Open or create today's daily note (YYYY-MM-DD.md in the Daily Notes folder), from a template if one exists.",
      category: 'vault',
      implemented: true,
      parameters: [param('date', 'string', false, 'YYYY-MM-DD (default: today, Africa/Lagos)')],
    },
    exec: async (args) => {
      const res = await vaultDailyNote(args.date ? String(args.date) : undefined)
      return res.ok
        ? { created: res.created, path: res.path, content: (res.content ?? '').slice(0, 3000) }
        : { ok: false, error: res.error }
    },
  },
  {
    info: {
      name: 'obsidian_query',
      description:
        'Dataview-style vault queries: LIST FROM #tag | LIST FROM "folder" | TABLE <props> FROM <source> | TASK (all open tasks).',
      category: 'vault',
      implemented: true,
      parameters: [param('query', 'string', true, "Dataview-lite query, e.g. 'LIST FROM #research'")],
    },
    exec: async (args) => {
      const res = await vaultQuery(String(args.query ?? ''))
      return { kind: res.kind, rows: res.rows.slice(0, 40), explanation: res.explanation }
    },
  },

  // ===== v5 learning loop — cross-session recall + self-knowledge =====
  {
    info: {
      name: 'search_sessions',
      description:
        'Search past conversations across all threads — cross-session recall. Returns matching messages with thread titles ' +
        'and snippets. Use whenever the user refers to something discussed before ("what did we say about X").',
      category: 'memory',
      implemented: true,
      parameters: [
        param('query', 'string', true, 'What to look for in past conversations'),
        param('limit', 'number', false, 'Max hits (default 8)', 8),
      ],
    },
    exec: async (args) => {
      const hits = await searchSessions(String(args.query ?? ''), Math.max(1, Math.min(20, Number(args.limit ?? 8))))
      return {
        found: hits.length,
        hits,
        note: hits.length ? 'Open the matching thread in the sidebar to see the full context.' : 'Nothing found in past sessions.',
      }
    },
  },
  {
    info: {
      name: 'learning_status',
      description:
        'How the learning loop is doing: auto-learned skills, last memory curation, and the distilled user model MIST is ' +
        'adapting to. Use when the user asks how well you know them or what you have learned.',
      category: 'memory',
      implemented: true,
      parameters: [],
    },
    exec: async () => {
      const model = getUserModel()
      const autoSkills = await countAutoSkills()
      return {
        auto_learned_skills: autoSkills,
        user_model: model ?? '(not built yet — it distills automatically every 12h)',
        note: 'Skills are auto-created from complex tasks and self-improve with use (version bumps). Memory curation runs every 6h.',
      }
    },
  },
]

const BASE_MAP = new Map<string, BaseToolDef>(BASE_TOOLS.map((t) => [t.info.name, t]))

// ---------- registry ----------

/** Full registry: 46 base + curated OmniRoute tools (+ learned skills as tools). */
export async function listTools(): Promise<ToolInfo[]> {
  const [omniAvailable, pilotOnline, skills] = await Promise.all([
    probeGateway(),
    pilotAvailable().catch(() => false),
    skillTools().catch(() => [] as ToolInfo[]),
  ])
  const omni: ToolInfo[] = OMNI_TOOLS.map((t) => ({
    ...t.info,
    write: t.write,
    available: omniAvailable,
  }))
  return [
    ...BASE_TOOLS.map((t) => ({
      ...t.info,
      ...(t.info.category === 'browser' ? { available: pilotOnline } : {}),
    })),
    ...omni,
    ...skills,
  ]
}

/** Look up a single tool (base, omniroute, or skill). */
export async function findTool(name: string): Promise<ToolInfo | null> {
  const base = BASE_MAP.get(name)
  if (base) return { ...base.info }
  const omni = OMNI_TOOLS.find((t) => t.info.name === name)
  if (omni) {
    return { ...omni.info, write: omni.write, available: await probeGateway() }
  }
  if (name.startsWith('skill:')) {
    const skills = await skillTools().catch(() => [] as ToolInfo[])
    return skills.find((s) => s.name === name) ?? null
  }
  return null
}

const SKILL_SUGGEST_CATEGORIES = new Set(['web', 'file', 'system', 'compute', 'utility'])

/**
 * Execute a tool. Never throws — always returns a JSON-safe ToolExecuteResult.
 * Unknown tool → success:false. Stub → success:true with a clear stub payload.
 */
export async function executeTool(
  name: string,
  rawArgs: unknown,
  confirmed = false
): Promise<ToolExecuteResult & { available?: boolean }> {
  const startedAt = Date.now()
  const args =
    rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {}

  const stubResult = (): ToolExecuteResult => ({
    success: true,
    output: { status: 'stub', message: STUB_MESSAGE(name) },
    error: null,
    tool: name,
    suggest_skill: false,
    duration_ms: Date.now() - startedAt,
  })

  try {
    // --- omniroute curated tools ---
    if (name.startsWith('omni_')) {
      const result = await executeOmniTool(name, args, confirmed)
      return { ...result, duration_ms: Date.now() - startedAt }
    }

    // --- learned skills ---
    if (name.startsWith('skill:')) {
      const output = await executeSkillTool(name.slice('skill:'.length), args)
      recordActivity('tool', `${name} ok`)
      return {
        success: true,
        output,
        error: null,
        tool: name,
        suggest_skill: false,
        duration_ms: Date.now() - startedAt,
      }
    }

    // --- base tools ---
    const def = BASE_MAP.get(name)
    if (!def) {
      return {
        success: false,
        output: null,
        error: `unknown tool: ${name}`,
        tool: name,
        duration_ms: Date.now() - startedAt,
      }
    }
    if (!def.info.implemented || !def.exec) {
      return stubResult()
    }
    const prepared = prepareArgs(def.info.parameters, args)
    const output = await def.exec(prepared)
    recordActivity('tool', `${name} ok`)
    return {
      success: true,
      output,
      error: null,
      tool: name,
      suggest_skill: SKILL_SUGGEST_CATEGORIES.has(def.info.category),
      duration_ms: Date.now() - startedAt,
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'tool execution failed'
    recordActivity('tool', `${name} failed: ${message}`)
    return {
      success: false,
      output: null,
      error: message,
      tool: name,
      duration_ms: Date.now() - startedAt,
    }
  }
}
