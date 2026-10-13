/// <reference types="bun-types" />
/**
 * MIST Phase 0 baseline harness — Sovereign Hardening Mandate.
 * Run: bun scripts/audit/baseline.ts          (all fast sections, ~4 min)
 *      bun scripts/audit/baseline.ts --tsc    (merge tsc result into existing JSON)
 *
 * Output: docs/baseline-<date>.json
 *
 * Constraints (docs/adr/0001-baseline-constraints.md):
 *  - `next build` is BANNED in this sandbox (dev server owns .next on :3000).
 *    Bundle size measured from the dev-mode first-load payload instead; the
 *    production number must be re-measured on the owner's PC.
 *  - Read-only GET routes only; side-effecting/POST/SSE/secret routes are
 *    skipped and listed (probing them would mutate owner data).
 *  - LLM-dependent probes (TTFT, candor corpus) need live lanes/local models —
 *    marked UNVERIFIED when absent rather than faked (R2 doctrine: no fake numbers).
 */
import { readdirSync, readFileSync, statSync, existsSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../..')
const OUT = join(ROOT, 'docs', `baseline-${new Date().toISOString().slice(0, 10)}.json`)
const BASE = 'http://127.0.0.1:3000'

const UNVERIFIED = (reason: string, method?: string) => ({ status: 'UNVERIFIED', reason, method })

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (['node_modules', '.next', '.git'].includes(e.name)) continue
      walk(p, exts, out)
    } else if (exts.some((x) => e.name.endsWith(x))) out.push(p)
  }
  return out
}

function sh(cmd: string, timeoutMs = 15_000): { ok: boolean; out: string } {
  try {
    const p = Bun.spawnSync(['bash', '-c', cmd], { cwd: ROOT, timeout: timeoutMs })
    return { ok: p.exitCode === 0, out: (p.stdout?.toString() ?? '') + (p.stderr?.toString() ?? '') }
  } catch (e) {
    return { ok: false, out: String(e) }
  }
}

function countMatches(files: string[], re: RegExp) {
  let n = 0
  const perFile: Record<string, number> = {}
  for (const f of files) {
    const c = (readFileSync(f, 'utf8').match(re) ?? []).length
    if (c) {
      n += c
      perFile[relative(ROOT, f)] = c
    }
  }
  return { count: n, perFile }
}

function pct(arr: number[], p: number) {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 100) / 100
}

async function timedFetch(path: string, timeoutMs = 30_000) {
  const t0 = performance.now()
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), timeoutMs)
    const r = await fetch(BASE + path, { signal: ctl.signal })
    const body = await r.text()
    clearTimeout(t)
    return { ok: r.ok, status: r.status, ms: Math.round(performance.now() - t0), bytes: body.length }
  } catch (e) {
    return { ok: false, status: 0, ms: Math.round(performance.now() - t0), bytes: 0, err: String(e).slice(0, 120) }
  }
}

// ---------------------------------------------------------------- sections

async function meta() {
  const git = sh('git rev-parse --short HEAD && git branch --show-current && git status --short | wc -l')
  const [sha, branch, dirty] = git.out.trim().split('\n')
  return {
    date: new Date().toISOString(),
    git: { sha, branch, dirtyFiles: Number(dirty) || 0 },
    machine: {
      memTotalMb: Math.round((Number(readFileSync('/proc/meminfo').toString().split('\n')[0].split(/\s+/)[1]) || 0) / 1024),
      loadavg: readFileSync('/proc/loadavg').toString().split(' ').slice(0, 3).join(' '),
    },
    constraints: [
      'next build banned in sandbox (dev server owns .next) — bundle = dev-mode first-load payload',
      'route timings: read-only GET subset only; POST/side-effect/SSE/secret routes skipped and listed',
      'idle outbound sampled 60s (6x10s) not 5min — sandbox session budget',
      'tsc runs as a separate --tsc pass to isolate its memory footprint',
    ],
  }
}

function configFlags() {
  const nextCfg = readFileSync(join(ROOT, 'next.config.ts'), 'utf8')
  const eslint = readFileSync(join(ROOT, 'eslint.config.mjs'), 'utf8')
  return {
    nextConfig: {
      ignoreBuildErrors: /ignoreBuildErrors:\s*true/.test(nextCfg),
      reactStrictMode: /reactStrictMode:\s*true/.test(nextCfg),
      outputStandalone: /output:\s*['"]standalone['"]/.test(nextCfg),
    },
    eslint: {
      rulesOff: (eslint.match(/: "off"/g) ?? []).length,
    },
    packageJson: {
      dbPushAcceptDataLoss: readFileSync(join(ROOT, 'package.json'), 'utf8').includes('--accept-data-loss'),
      name: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).name,
    },
  }
}

function repoCounts() {
  const routes = walk(join(ROOT, 'src/app/api'), ['.ts']).filter((f) => f.endsWith('route.ts'))
  const tests = [...walk(join(ROOT, 'src'), ['.test.ts', '.test.tsx', '.spec.ts']), ...walk(join(ROOT, 'tests'), ['.test.ts'])]
  const skillsMd = walk(join(ROOT, 'db/skills'), ['.md'])
  const schema = readFileSync(join(ROOT, 'prisma/schema.prisma'), 'utf8')
  const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8')
  return {
    routes: { total: routes.length, underMist: routes.filter((f) => f.includes('/api/mist/')).length },
    tests: tests.length,
    runtimeSkills: { mdFiles: skillsMd.length, names: skillsMd.map((f) => relative(join(ROOT, 'db/skills'), f)) },
    prisma: {
      models: (schema.match(/^model /gm) ?? []).length,
      indexDirectives: (schema.match(/@@index/g) ?? []).length,
      uniqueDirectives: (schema.match(/@@unique/g) ?? []).length,
    },
    gitignore: {
      missesDbFiles: !/db\/\*\.db/.test(gitignore),
      missesDbBackups: !/db\/backups/.test(gitignore),
      missesDbNotes: !/db\/notes/.test(gitignore),
      trackedDbFiles: Number(sh("git ls-files | grep -c '^db/'").out.trim()) || 0,
      trackedSecretFiles: sh("git ls-files | grep -E 'provider-keys|custom.db'").out.trim().split('\n').filter(Boolean),
    },
  }
}

function deadDeps() {
  const deps = ['@mdxeditor/editor', '@dnd-kit/core', '@dnd-kit/sortable', '@dnd-kit/utilities',
    '@tanstack/react-query', '@tanstack/react-table', '@reactuses/core', 'next-auth', 'next-intl',
    'react-syntax-highlighter', 'uuid', 'zod']
  const codeFiles = [
    ...walk(join(ROOT, 'src'), ['.ts', '.tsx']),
    ...walk(join(ROOT, 'mini-services'), ['.ts']),
    ...walk(join(ROOT, 'scripts'), ['.ts']),
  ]
  const esc = (d: string) => d.replace(/[/@]/g, '\\$&')
  const result: Record<string, { imports: number; verdict: string }> = {}
  for (const d of deps) {
    let imports = 0
    const re = new RegExp(`from ['"]${esc(d)}['"]|require\\(['"]${esc(d)}['"]\\)`, 'g')
    for (const f of codeFiles) imports += (readFileSync(f, 'utf8').match(re) ?? []).length
    result[d] = { imports, verdict: imports === 0 ? 'DEAD — safe to remove' : `USED (${imports}) — keep` }
  }
  // sharp: zero direct imports, but required by next/image production optimization.
  const sharpImports = codeFiles.reduce((n, f) => n + (readFileSync(f, 'utf8').match(/from ['"]sharp['"]/g) ?? []).length, 0)
  result['sharp'] = { imports: sharpImports, verdict: 'KEEP — next/image prod optimizer (0 direct imports)' }
  return result
}

function uiCostCounts() {
  const src = walk(join(ROOT, 'src'), ['.tsx', '.ts'])
  const small = countMatches(src, /text-\[(9|10|11)px\]/g)
  return {
    text9px: countMatches(src, /text-\[9px\]/g).count,
    text10px: countMatches(src, /text-\[10px\]/g).count,
    text11px: countMatches(src, /text-\[11px\]/g).count,
    textSmallTotal: small.count,
    backdropBlurDirect: countMatches(src, /backdrop-blur/g).count,
    mistGlassUsages: countMatches(src, /mist-glass/g).count,
    vh100: countMatches(src, /100vh/g).count,
    dvh: countMatches(src, /\ddvh/g).count,
    safeArea: countMatches(src, /safe-area/g).count,
    topOffendersTextSmall: Object.entries(small.perFile)
      .sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([f, c]) => `${f}: ${c}`),
  }
}

async function toolsList() {
  const r = await timedFetch('/api/mist/tools/list')
  if (!r.ok) return { status: 'UNVERIFIED', reason: `tools/list failed: ${r.status}` }
  const tools: Array<Record<string, unknown>> = JSON.parse(await (await fetch(BASE + '/api/mist/tools/list')).text())
  const list = Array.isArray(tools) ? tools : ((tools as any).tools ?? [])
  const descChars = list.reduce((n, t) => n + String(t.description ?? '').length, 0)
  const nameChars = list.reduce((n, t) => n + String(t.name ?? '').length, 0)
  const paramChars = list.reduce((n, t) => n + JSON.stringify(t.parameters ?? {}).length, 0)
  return {
    payloadBytes: r.bytes,
    count: list.length,
    implemented: list.filter((t) => t.implemented !== false).length,
    descChars,
    approxTokensDescOnly: Math.round(descChars / 4),
    approxTokensFullBlock: Math.round((descChars + nameChars + paramChars) / 4),
    largest: [...list].sort((a, b) => String(b.description ?? '').length - String(a.description ?? '').length).slice(0, 5)
      .map((t) => `${t.name}: ${String(t.description ?? '').length}c`),
  }
}

async function devBundle() {
  const html = await (await fetch(BASE + '/')).text()
  const srcs = [...html.matchAll(/src="([^"]*_next\/static[^"]*\.js[^"]*)"/g)].map((m) => m[1])
  let raw = 0, gz = 0
  for (const s of srcs) {
    try {
      const b = new Uint8Array(await (await fetch(s.startsWith('http') ? s : BASE + s)).arrayBuffer())
      raw += b.length
      gz += Bun.gzipSync(b).length
    } catch { /* skip */ }
  }
  const staticDir = join(ROOT, '.next/static')
  let diskBytes = 0
  if (existsSync(staticDir)) {
    for (const f of walk(staticDir, ['.js'])) diskBytes += statSync(f).size
  }
  return {
    method: 'dev-mode first-load payload (NOT production build — see constraints)',
    scriptsReferenced: srcs.length,
    firstLoadJsRaw: raw,
    firstLoadJsGzip: gz,
    nextStaticDiskBytes: diskBytes,
  }
}

async function buildContextTiming() {
  try {
    const mod = await import('../../src/lib/services/context-builder')
    const msg = 'hey, what can you actually do around here?'
    const t: number[] = []
    let promptChars = 0, toolsBlockChars = 0
    await mod.buildContext(msg, 'chat' as never) // warmup (skills import gate, lazy imports)
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now()
      const ctx = await mod.buildContext(msg, 'chat' as never)
      t.push(performance.now() - t0)
      promptChars = ctx.prompt.length
      const m = ctx.prompt.match(/TOOLS AVAILABLE:[\s\S]*?(?=\n\n[A-Z#]|\n\n$|$)/)
      toolsBlockChars = m ? m[0].length : toolsBlockChars
    }
    return {
      p50ms: pct(t, 50), p95ms: pct(t, 95), minMs: Math.round(Math.min(...t)), samples: t.map((x) => Math.round(x)),
      promptChars,
      promptApproxTokens: Math.round(promptChars / 4),
      toolsBlockChars,
      toolsBlockApproxTokens: Math.round(toolsBlockChars / 4),
    }
  } catch (e) {
    return UNVERIFIED(String(e).slice(0, 200))
  }
}

const SAFE_GETS = [
  '/api/mist/health', '/api/mist/tools/list', '/api/mist/tools/categories', '/api/mist/skills/list',
  '/api/mist/skills/executions', '/api/mist/missions', '/api/mist/memory/stats', '/api/mist/llm/lanes',
  '/api/mist/llm/status', '/api/mist/telemetry', '/api/mist/traces', '/api/mist/dreams', '/api/mist/agents',
  '/api/mist/subagents', '/api/mist/companions', '/api/mist/watchlist', '/api/mist/autonomy',
  '/api/mist/operators', '/api/mist/connectors', '/api/mist/introspection', '/api/mist/alerts',
  '/api/mist/approvals', '/api/mist/conversations', '/api/mist/digest', '/api/mist/trends',
  '/api/mist/research', '/api/mist/evolution', '/api/mist/github', '/api/mist/obsidian',
  '/api/mist/browser/status', '/api/mist/bridge', '/api/mist/hermes', '/api/mist/learning',
  // Phase 3-a · R12: /api/mist/mesh + /api/mist/data-boundary DELETED (dead routes,
  // zero callers — phase-0 verdict). They 404 now; removed from the probe set.
  '/api/mist/analytics/efficiency', '/api/mist/cron',
  '/api/mist/voice/status', '/api/mist/voice/local/status', '/api/mist/voice/local/engines', '/api',
]
const SKIPPED_ROUTES = [
  '/api/mist/welcome (GET has side-effect seen-gate)', '/api/mist/recover (kills processes — do not probe)',
  '/api/mist/google (returns GEMINI_API_KEY)', '/api/mist/synapse/stream (SSE long-lived)',
  '/api/mist/voice/tts/stream (SSE)', '/api/mist/evolution/scan (side-effecting scan)',
  'all POST-only routes (LLM/writes)', 'all [id] dynamic routes (need params)',
]

async function routeLatency() {
  const results: Record<string, { coldMs: number; status: number; p50ms: number | null; p95ms: number | null; warmMs: number[] }> = {}
  for (const p of SAFE_GETS) {
    const cold = await timedFetch(p, 45_000)
    const warm: number[] = []
    for (let i = 0; i < 5; i++) {
      const r = await timedFetch(p, 45_000)
      if (r.ok) warm.push(r.ms)
    }
    results[p] = { coldMs: cold.ms, status: cold.status, p50ms: pct(warm, 50), p95ms: pct(warm, 95), warmMs: warm }
  }
  const p50s = Object.values(results).map((r) => r.p50ms).filter((x): x is number => x != null)
  const p95s = Object.values(results).map((r) => r.p95ms).filter((x): x is number => x != null)
  return {
    method: 'read-only GET subset (dev-mode; cold = first-hit incl. on-demand compile)',
    probed: SAFE_GETS.length,
    skipped: SKIPPED_ROUTES,
    aggregateP50ms: pct(p50s, 50), aggregateP95ms: pct(p95s, 50),
    slowest: Object.entries(results).sort((a, b) => (b[1].p95ms ?? 0) - (a[1].p95ms ?? 0)).slice(0, 6)
      .map(([p, r]) => `${p} p95=${r.p95ms}ms cold=${r.coldMs}ms status=${r.status}`),
    routes: results,
  }
}

async function bindsAndLocalModels() {
  const ss = sh('ss -tlnp 2>/dev/null').out
  const listeners = ss.split('\n').filter((l) => /:(3000|3003|3004|3030|8734)\s/.test(l))
    .map((l) => l.trim().replace(/\s+/g, ' '))
  const localModels: Record<string, unknown> = {}
  for (const [name, port] of [['ollama', 11434], ['lmstudio', 1234], ['llamacpp', 8080]] as const) {
    try {
      const ctl = new AbortController()
      const t = setTimeout(() => ctl.abort(), 800)
      const r = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: ctl.signal })
      clearTimeout(t)
      localModels[name] = { present: r.ok, port }
    } catch {
      localModels[name] = { present: false, port }
    }
  }
  return { listeners, localModels }
}

async function idleSampling() {
  const pidLine = sh("pgrep -f 'next-server' | head -1").out.trim()
  let cpuPct: number | null = null
  if (pidLine) {
    const read = () => {
      try {
        const s = readFileSync(`/proc/${pidLine}/stat`).toString().split(' ')
        return { u: Number(s[13]), s: Number(s[14]) }
      } catch { return null }
    }
    const a = read()
    if (a) {
      await Bun.sleep(10_000)
      const b = read()
      if (b) cpuPct = Math.round(((b.u + b.s - a.u - a.s) / 10_000) * 100 * 100) / 100
    }
  }
  const ourPids = sh("pgrep -f 'next-server|neural-service|mesh-service|browser-pilot|mist-bridge'").out.split('\n').filter(Boolean)
  const snaps: Array<{ t: number; conns: string[] }> = []
  for (let i = 0; i < 6; i++) {
    await Bun.sleep(10_000)
    const ss = sh('ss -tnp state established 2>/dev/null').out
    const conns = ss.split('\n').filter((l) =>
      ourPids.some((p) => l.includes(`pid=${p}`)) && !/127\.0\.0\.1|\[::1\]/.test(l),
    ).map((l) => l.trim().replace(/\s+/g, ' '))
    snaps.push({ t: i + 1, conns })
  }
  return {
    method: 'CPU: 10s /proc stat of next-server; outbound: 6x10s ss established (non-loopback, our pids)',
    nextServerPid: pidLine || null,
    nextServerCpuPctOver10s: cpuPct,
    idleOutbound: { snapshots: snaps.length, totalNonLoopbackConns: snaps.reduce((n, s) => n + s.conns.length, 0), perSnapshot: snaps.map((s) => s.conns.length), sample: snaps.flatMap((s) => s.conns).slice(0, 5) },
  }
}

function unverifiedBlock() {
  return {
    buildTime: UNVERIFIED('next build banned in sandbox — measure on owner PC', 'bun run build on PC, record duration'),
    productionBundle: UNVERIFIED('next build banned in sandbox — dev-mode proxy recorded in devBundle', 'compare .next/standalone + analyzer on PC'),
    ttftKeyless: UNVERIFIED('live keyless-lane round trip needs external egress; sandbox egress restricted', 'on PC: 3x unified() on a keyless lane, record first-token ms'),
    candorCorpus: UNVERIFIED('no local model present (probed in binds.localModels)', 'C5 harness after Phase 5 wizard'),
    heap20MountUnmount: UNVERIFIED('needs a Playwright heap harness (Phase 3 instrumentation work)', 'mount/unmount chat-panel 20x, record JSHeapUsedSize deltas'),
  }
}

// ---------------------------------------------------------------- runner

async function main() {
  const onlyTsc = process.argv.includes('--tsc')
  let report: Record<string, unknown>
  if (onlyTsc) {
    report = JSON.parse(readFileSync(OUT, 'utf8'))
    console.log('[tsc] running bunx tsc --noEmit (timeout 300s)…')
    const t0 = Date.now()
    const p = Bun.spawn(['bunx', 'tsc', '--noEmit'], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' })
    const killer = setTimeout(() => p.kill(), 300_000)
    const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text())
    const exit = await p.exited
    clearTimeout(killer)
    const errors = (out.match(/error TS/g) ?? []).length
    report.tsc = {
      exitCode: exit, errorCount: errors, durationMs: Date.now() - t0,
      verdict: exit === 0 ? 'CLEAN (0 errors)' : errors ? `${errors} errors` : `exit ${exit} (killed/OOM?)`,
      outputTail: out.split('\n').slice(-5).join('\n').slice(0, 400),
    }
  } else {
    const t0 = Date.now()
    console.log('[1/8] meta + config + counts…')
    const m = await meta()
    const cfg = configFlags()
    const counts = repoCounts()
    console.log('[2/8] dead deps…')
    const deps = deadDeps()
    console.log('[3/8] ui cost counts…')
    const ui = uiCostCounts()
    console.log('[4/8] tools list…')
    const tools = await toolsList()
    console.log('[5/8] dev bundle payload…')
    const bundle = await devBundle()
    console.log('[6/8] buildContext timing (11 calls)…')
    const ctx = await buildContextTiming()
    console.log('[7/8] route latency (' + SAFE_GETS.length + ' routes x 6 hits)…')
    const routes = await routeLatency()
    console.log('[8/8] binds + idle sampling (70s)…')
    const binds = await bindsAndLocalModels()
    const idle = await idleSampling()
    report = {
      ...m,
      configFlags: cfg,
      repoCounts: counts,
      deadDeps: deps,
      uiCost: ui,
      toolsList: tools,
      devBundle: bundle,
      buildContext: ctx,
      routeLatency: routes,
      binds,
      idle,
      unverified: unverifiedBlock(),
      harnessDurationMs: Date.now() - t0,
      tsc: 'run separately: bun scripts/audit/baseline.ts --tsc',
    }
    console.log(`fast sections done in ${Math.round((Date.now() - t0) / 1000)}s`)
  }
  writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n')
  console.log(`written: ${relative(ROOT, OUT)}`)
}

await main()
