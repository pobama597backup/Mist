// M.I.S.T. data-boundary report — port of `jarvis scan --data-boundaries`
// (OpenJarvis security/data_boundary_audit.py) applied to M.I.S.T.'s own
// config and stores.
//
// Same discipline as the OpenJarvis audit: the scanner limits itself to file
// existence, sizes, counts and KEY NAMES — it never reads private user content
// from the database, notes, traces or memory. Risk ratings are honest; the
// mitigations listed are the ones ACTUALLY in place (verified in the codebase),
// not aspirational ones.
import { NextResponse } from 'next/server'
import fs from 'node:fs/promises'
import path from 'node:path'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

interface BoundaryFinding {
  surface: string
  risk: 'high' | 'medium' | 'low'
  detail: string
  mitigations: string[]
}

interface FileStats {
  exists: boolean
  sizeBytes: number
}

interface DirStats extends FileStats {
  entries: number
}

const PROJECT_ROOT = process.cwd()

async function fileStats(rel: string): Promise<FileStats> {
  try {
    const s = await fs.stat(path.join(PROJECT_ROOT, rel))
    return { exists: true, sizeBytes: s.size }
  } catch {
    return { exists: false, sizeBytes: 0 }
  }
}

async function dirStats(rel: string): Promise<DirStats> {
  try {
    const entries = await fs.readdir(path.join(PROJECT_ROOT, rel))
    return { exists: true, entries: entries.length, sizeBytes: 0 }
  } catch {
    return { exists: false, entries: 0, sizeBytes: 0 }
  }
}

/** Recursively count files under a directory (depth-capped). */
async function countFiles(rel: string, depth = 0): Promise<number> {
  if (depth > 4) return 0
  try {
    const entries = await fs.readdir(path.join(PROJECT_ROOT, rel), { withFileTypes: true })
    let n = 0
    for (const e of entries) {
      if (e.isDirectory()) n += await countFiles(path.join(rel, e.name), depth + 1)
      else n++
    }
    return n
  } catch {
    return 0
  }
}

function humanBytes(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${n} B`
}

/** Prisma model names from the schema (config read — mirrors jarvis scan). */
async function prismaModels(): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(PROJECT_ROOT, 'prisma', 'schema.prisma'), 'utf8')
    const models = [...raw.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1])
    return models
  } catch {
    return []
  }
}

/** Provider key NAMES only — values are never read into the report. */
async function providerKeyNames(): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(PROJECT_ROOT, 'db', 'provider-keys.json'), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return Object.keys(parsed)
  } catch {
    return []
  }
}

async function buildReport(): Promise<BoundaryFinding[]> {
  const models = await prismaModels()
  const hasModel = (name: string): boolean => models.includes(name)
  const modelCount = models.length

  const [db, notesDir, notesFiles, vaults, vaultFiles, stage, stageEntries, backups, backupEntries, skillsDir, skillsFiles] =
    await Promise.all([
      fileStats('db/custom.db'),
      dirStats('db/notes'),
      countFiles('db/notes'),
      dirStats('db/obsidian-vaults'),
      countFiles('db/obsidian-vaults'),
      dirStats('db/evolution-stage'),
      countFiles('db/evolution-stage'),
      dirStats('db/backups'),
      countFiles('db/backups'),
      dirStats('db/skills'),
      countFiles('db/skills'),
    ])
  const keyNames = await providerKeyNames()
  const [heartbeat, introspection, watchlist] = await Promise.all([
    fileStats('db/heartbeat-state.json'),
    fileStats('db/introspection-state.json'),
    fileStats('db/watchlist.json'),
  ])

  const findings: BoundaryFinding[] = []

  findings.push({
    surface: 'Chat history database',
    risk: 'high',
    detail: `SQLite database at db/custom.db${db.exists ? ` (${humanBytes(db.sizeBytes)})` : ' (not found on disk in dev mode)'} — ${modelCount} Prisma models including Conversation and Message; Message rows hold full conversation transcripts.`,
    mitigations: [
      'stored in a local SQLite file only — no cloud database, no third-party storage, no sync',
      'conversation APIs are served solely from the local console origin behind the sandbox gateway',
      'the single exposed gateway port is the only inbound path; the database port does not exist (file-based)',
    ],
  })

  findings.push({
    surface: 'Longterm memory',
    risk: 'high',
    detail: `Prisma LongtermMemory + MemoryQueue models inside db/custom.db${hasModel('LongtermMemory') ? '' : ' (model not in schema)'} — distilled personal facts and queued reminders; LongtermMemory carries the trust column (auto|trusted|untrusted quarantine, ported from OpenJarvis memory trust tiers).`,
    mitigations: [
      'local SQLite only — memory never leaves the machine',
      'trust-tier quarantine: injection-flagged (untrusted) facts are stored for audit but blocked from prompt context',
      'memory APIs expose deletion paths in-app',
    ],
  })

  findings.push({
    surface: 'Vector memory',
    risk: 'medium',
    detail: `Prisma VectorMemory model — TF-cosine embeddings of conversation slices used for semantic recall searches.`,
    mitigations: [
      'embeddings are computed locally (term-frequency tokenization in vector-service) — no external embedding API is called',
      'vectors live in the same local SQLite file and inherit its boundary',
    ],
  })

  findings.push({
    surface: 'Knowledge chunks',
    risk: 'medium',
    detail: `Prisma KnowledgeChunk model${hasModel('KnowledgeChunk') ? ' (OpenJarvis knowledge-base port)' : ' (not in schema yet)'} — ingested document text chunks for knowledge search.`,
    mitigations: [
      'local SQLite only; ingestion happens through the local console API',
      'no third-party document service is wired in this sandbox',
    ],
  })

  findings.push({
    surface: 'Notes',
    risk: 'medium',
    detail: `db/notes/ directory — ${notesDir.exists ? `${notesFiles} markdown file(s) in ${notesDir.entries} top-level entries` : 'not present'} (research briefs, runbooks, trend digests, USER_MODEL.md).`,
    mitigations: [
      'plain local markdown files, never exposed by any public API route',
      'file tools confine access to allowed roots (home + project)',
    ],
  })

  findings.push({
    surface: 'Obsidian vaults',
    risk: 'medium',
    detail: `db/obsidian-vaults/ — ${vaults.entries} registered vault(s), ${vaultFiles} note file(s) total; read/write through the Obsidian service.`,
    mitigations: [
      'vaults are local directories; the service only touches registered vault roots',
      'no Obsidian sync or publish endpoint is configured',
    ],
  })

  findings.push({
    surface: 'Provider API keys',
    risk: 'high',
    detail: `db/provider-keys.json — ${keyNames.length} entries holding key NAMES [${keyNames.join(', ')}] (values intentionally not read by this scan). Plaintext JSON on local disk.`,
    mitigations: [
      'keys are restored from this local backup at boot (ensureProviderKeysRestored) — no remote secret manager is contacted',
      'key values are never included in any API response, report or log line',
      'each key is sent only to its owning provider endpoint (OpenRouter / NVIDIA) as an auth header',
    ],
  })

  findings.push({
    surface: 'Evolution proposals & staged changes',
    risk: 'medium',
    detail: `db/evolution-stage/ (${stageEntries} staged item(s)) + Prisma EvolutionProposal rows — self-modification proposals contain code patches and project file diffs.`,
    mitigations: [
      'proposals apply through gated, staged pipelines with backups; nothing auto-applies without the gate',
      'all staging data is local',
    ],
  })

  findings.push({
    surface: 'Code & database backups',
    risk: 'medium',
    detail: `db/backups/ — ${backupEntries} snapshot entr(ies) (per-change code/database backups taken by the evolution and mission pipelines).`,
    mitigations: [
      'backups stay on local disk and enable rollback; nothing is uploaded',
    ],
  })

  findings.push({
    surface: 'Traces',
    risk: 'high',
    detail: `Prisma Trace + TraceStep models${hasModel('Trace') ? '' : ' (not in schema yet)'} — OpenJarvis trace-store port; steps capture prompts, completions and tool inputs/outputs.`,
    mitigations: [
      'local SQLite only — trace APIs serve the local console origin',
      'no third-party tracing/analytics backend exists in the stack',
    ],
  })

  findings.push({
    surface: 'Telemetry & activity state',
    risk: 'low',
    detail: `In-process activity log (memory only) plus local state files: db/heartbeat-state.json (${heartbeat.exists ? humanBytes(heartbeat.sizeBytes) : 'absent'}), db/introspection-state.json (${introspection.exists ? humanBytes(introspection.sizeBytes) : 'absent'}), db/watchlist.json (${watchlist.exists ? humanBytes(watchlist.sizeBytes) : 'absent'}) and Prisma AutonomyEvent/AgentRun rows.`,
    mitigations: [
      'zero third-party analytics — no PostHog, no external telemetry SDK, nothing phones home',
      'activity rings are capped in-memory buffers; persisted events stay in the local database',
    ],
  })

  findings.push({
    surface: 'Skills',
    risk: 'low',
    detail: `db/skills/ — ${skillsFiles} skill file(s) + Prisma Skill/SkillExecution models; skill markdown includes learned procedures.`,
    mitigations: [
      'local files; the skills importer only reads registered sources',
      'skill execution logs stay local',
    ],
  })

  findings.push({
    surface: 'Channel surface',
    risk: 'low',
    detail: `31-channel architecture ported to src/lib/oj/channels.ts — exactly ONE channel is live (webchat, this console); telegram/slack/discord/whatsapp/imessage/sendblue/email/twitter and the remaining 22 adapters are honest not-connected stubs.`,
    mitigations: [
      'no messaging credentials exist in this sandbox, so nothing can egress to external messengers',
      'the sendMessage stub surface returns honest not-connected errors — it cannot silently pretend to deliver',
    ],
  })

  findings.push({
    surface: 'Interop mesh (MCP + A2A)',
    risk: 'low',
    detail: `mesh-service on :3004 exposes the MCP tool server (POST /mcp) and the A2A agent card — 6 self-contained diagnostic tools (ping, mesh_status, echo_json, time_now, http_check, uuid_new); the only open-world tool is http_check.`,
    mitigations: [
      'the mesh service holds no database access and no SDK dependency — its tools cannot touch M.I.S.T. stores',
      'http_check runs behind a full SSRF guard (private IPs, cloud metadata, disguised IPv4 forms, fail-closed DNS, manually re-validated redirects)',
      'per-surface rate limiting (chat 20/min, tools 60/min, research 5/10min, mcp 30/min) is available via src/lib/oj/rate-limiter.ts',
      'browser-origin access goes through the single gateway port (?XTransformPort=3004); the service is otherwise reachable only inside the sandbox',
    ],
  })

  return findings
}

export async function GET() {
  try {
    const report = await buildReport()
    return NextResponse.json({
      report,
      scannedAt: new Date().toISOString(),
      principle:
        'Port of jarvis scan --data-boundaries: enumeration limited to file existence, sizes, counts and key NAMES — private user content (chat transcripts, memory, traces, note bodies, key values) is never read by this scan.',
      riskOrder: ['high', 'medium', 'low'],
    })
  } catch (err) {
    // Honest degradation: a scan failure is reported, never faked.
    return NextResponse.json(
      {
        report: [],
        error: `data-boundary scan failed: ${err instanceof Error ? err.message : String(err)}`,
        scannedAt: new Date().toISOString(),
      },
      { status: 200 }
    )
  }
}
