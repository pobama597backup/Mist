#!/usr/bin/env node
/* eslint-disable */
// ============================================================
// M.I.S.T. BRIDGE v3 — local system-control + agent-stack daemon
// ------------------------------------------------------------
// The user-side half of M.I.S.T.'s local control: a tiny,
// zero-dependency Node.js HTTP daemon that M.I.S.T.'s backend proxies
// system-control requests to. It runs on YOUR machine, under YOUR user,
// and only you decide to start it.
//
// HOW TO RUN
//   node mist-bridge.js            → HTTP daemon (default port 8734)
//   node mist-bridge.js --mcp      → MCP stdio server (for `hermes mcp add`)
//   (requires Node 16+; zero npm dependencies — Node builtins only)
//   Optional: set MIST_BRIDGE_PORT to change the port (default 8734).
//
// WHAT'S NEW IN v3.3
//   - FULL FILE OPERATIONS: `move_file`, `copy_file`, `delete_file`,
//     `make_dir` — alongside the existing `list_dir` / `read_file` /
//     `write_file`, M.I.S.T. can now completely operate your files
//     (check a folder, reorganize photos, clean up downloads, …) without
//     ever shelling out. Everything stays jailed to your home directory;
//     overwrites must be explicit (overwrite: true); recursive directory
//     deletion must be explicit (recursive: true) — never accidental.
//
// WHAT'S NEW IN v3.2
//   - WINDOWS UI AUTOMATION: `ui_automate` drives native Windows apps —
//     open Settings straight to a deep-linked page (ms-settings:network-status,
//     …), inspect the live control tree, find elements, click buttons and set
//     toggles (e.g. turn ON Metered connection) through the .NET Framework
//     System.Windows.Automation assemblies (UIAutomationClient/
//     UIAutomationTypes) built into every Windows install — zero dependencies.
//     Windows-only; every script is assembled from strictly-validated
//     fragments (see SECURITY NOTES) so the LLM can SEE the Settings tree
//     before acting on it.
//
// WHAT'S NEW IN v3.1
//   - SYSTEM WATCH: `system_watch` returns one full machine snapshot —
//     CPU load, RAM, disk free, temperature, battery, Windows Defender
//     status, failed logons (24h), top processes, GPUs, uptime. Every probe
//     is individually timed out + try/catch'd, so a laptop without thermal
//     sensors or an admin-locked event log still gets a full report with
//     nulls. Mist's heartbeat samples it every 5 minutes and warns the user
//     in chat BEFORE things go wrong (CPU/RAM/disk/heat/Defender/logons).
//   - HARDWARE-AWARE VOICE: voice_status now reports the machine's GPUs and
//     a tier recommendation that explains itself; voice_setup accepts tier
//     'auto' (the best tier this PC can run) — "Mist, upgrade your voice".
//
// WHAT'S NEW IN v3
//   - LOCAL VOICE: whisper.cpp (offline speech-to-text) + Piper (offline
//     text-to-speech) engines, downloaded on demand into ~/.mist/voice and
//     run ON THIS MACHINE. `voice_setup` installs them (~150MB one-time),
//     `voice_stt` transcribes a captured WAV, `voice_tts` synthesizes one.
//     No cloud involved — mic audio never leaves the PC.
//
// WHAT'S NEW IN v2
//   - Companions: detects the local agent stack (Hermes agent, backtalk,
//     ai-visualizer, barehands, Claude Code) installed on this machine.
//   - Hermes integration: delegate one-shot tasks to a local Hermes
//     install, read/append its curated memory, list/export skills both
//     ways, drive its cron, inspect sessions — `hermes_*` actions.
//   - Signal bus: writes the backtalk/ai-visualizer ".voice_*" file
//     contract so every companion visualizer (circuit board, radial,
//     rain, neural core, barehands ring) performs M.I.S.T.'s live voice
//     state on this machine — zero config when ai-visualizer is found.
//   - MCP mode: `node mist-bridge.js --mcp` speaks the Model Context
//     Protocol over stdio so the Hermes agent (or any MCP client) can
//     call M.I.S.T. as a tool: ask her brain, search her memory, drive
//     her faces. Register with:
//       hermes mcp add mist --command node --args "/full/path/mist-bridge.js --mcp"
//
// SECURITY NOTES
//   - HTTP daemon listens on 127.0.0.1 ONLY — nothing outside this
//     machine can reach it.
//   - File operations (read/write/list/run cwd) are jailed to your home
//     directory; anything resolving outside is rejected.
//   - Commands run as your own user with a hard timeout — the same
//     privileges you have at a terminal, nothing more.
//   - Hermes flags that reach a shell are strictly validated (thread /
//     model / toolset / skill names, ids, schedules) — free text (the
//     task prompt) travels via a temp file, never through the command
//     line.
//   - Voice engine downloads are restricted to a HARDCODED allowlist of
//     hosts (github.com + the huggingface.co / hf.co first-party CDNs) and
//     size/magic-validated before use; engine binaries are ALWAYS spawned by
//     absolute path from ~/.mist/voice/bin — never from PATH. Only the
//     voice_stt action accepts a larger body (a base64 WAV, action-sniffed);
//     every other action keeps the strict 1MB cap.
//   - UI automation (ui_automate) PowerShell scripts are assembled ONLY from
//     validated parts: page keys come from a hardcoded ms-settings allowlist,
//     and window/name strings must pass a strict character allowlist (letters,
//     digits, space, .:_#-() — no quotes, backticks, $, semicolons, braces),
//     so nothing user-supplied can escape the single-quoted PS literals it
//     lands in. Scripts run through the same profile-less, non-interactive
//     PowerShell path as every other probe, with hard timeouts and node/time-
//     capped tree walks.
//
// Once running: open M.I.S.T. → Settings → Local Bridge → it connects.
// ============================================================

'use strict'

const http = require('http')
const https = require('https')
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const { spawn, exec } = require('child_process')

// ---------------- config ----------------

const VERSION = '3.5.0'
const PORT = Number.parseInt(process.env.MIST_BRIDGE_PORT || '8734', 10) || 8734
const HOST = '127.0.0.1' // loopback only — never exposed to the network
const PLATFORM = os.platform() // 'win32' | 'darwin' | 'linux'
const HOME = os.homedir()
const MIST_DIR = path.join(HOME, '.mist')
const BRIDGE_CONFIG = path.join(MIST_DIR, 'bridge.json')

const MAX_BODY_BYTES = 1024 * 1024 // 1MB JSON body cap (voice_stt gets more)
const MAX_VOICE_BODY_BYTES = 17 * 1024 * 1024 // voice_stt carries a base64 WAV (≤12MB decoded)
const MAX_APPS_WALK = 400 // stop scanning the start menu after this many files
const MAX_APPS_RETURN = 300
const MAX_DIR_ENTRIES = 500
const MAX_FILE_BYTES = 1024 * 1024 // 1MB read/write cap
const MAX_CMD_OUTPUT = 10000 // chars of stdout/stderr returned per command
const DEFAULT_CMD_TIMEOUT = 30000
const MAX_CMD_TIMEOUT = 60000

// ---------------- tiny helpers ----------------

/** Coerce an unknown arg into a trimmed string ('' when not a string). */
function str(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** Clamp an integer arg between lo and hi (fallback when unparsable). */
function clampInt(value, fallback, lo, hi) {
  const n = Number.parseInt(String(value), 10)
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, n))
}

/** Cap a string at maxLen chars, marking the cut with an ellipsis. */
function capOut(text, maxLen) {
  if (typeof text !== 'string') return ''
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen)}…[truncated]`
}

/** Dice bigram similarity (0..1) — cheap fuzzy scoring for app-name matches. */
function similarity(a, b) {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const bigrams = new Set()
  for (let i = 0; i < a.length - 1; i++) bigrams.add(a.slice(i, i + 2))
  let hits = 0
  for (let i = 0; i < b.length - 1; i++) {
    if (bigrams.has(b.slice(i, i + 2))) hits++
  }
  return hits / (a.length - 1 + b.length - 1)
}

// ---------------- home jail ----------------

class JailError extends Error {}

/** True when resolved is the home dir itself or inside it. */
function insideHome(resolved) {
  if (PLATFORM === 'win32') {
    const r = resolved.toLowerCase()
    const h = HOME.toLowerCase()
    return r === h || r.startsWith(h + path.sep)
  }
  return resolved === HOME || resolved.startsWith(HOME + path.sep)
}

/**
 * Resolve a user-supplied path and enforce the home-directory jail.
 * Relative paths resolve against the home directory. Throws JailError
 * ('path outside home directory') on escape attempts like ../../etc/shadow.
 */
function jailPath(input) {
  const raw = str(input)
  if (!raw) throw new JailError('path is required')
  const resolved = path.resolve(HOME, raw)
  if (!insideHome(resolved)) throw new JailError('path outside home directory')
  return resolved
}

// ---------------- self-modification guard (v3.5) ----------------
//
// WHY: on 2026-09-26 Mist completed a mission by writing her OWN source code
// (src/app/api/mist/health/route.ts) through this bridge's write_file —
// bypassing her evolution gate entirely (no backup, no lint gate, no approval,
// no rollback). The home jail can't stop this because the MIST project lives
// INSIDE the home directory (sandbox: /home/z/my-project; a user PC:
// ~/mist or similar). The same hole that let her "succeed" that time lets a
// hallucinating iteration brick her own source with zero safety net.
//
// RULE: the bridge never modifies the MIST project it serves. Inspection
// (read/list/stat/search) stays allowed — diagnosis is how she grows. All
// self-modification must go through her gated evolution path (mist_self_patch:
// backup-first, lint-gated, approval, auto-rollback).

/** True when dir looks like a MIST project root: package.json plus her
 *  distinctive source layout. Travels to any PC wherever the user put the
 *  project — no hardcoded paths. */
function looksLikeMistProject(dir) {
  try {
    if (!fs.existsSync(path.join(dir, 'package.json'))) return false
    return (
      fs.existsSync(path.join(dir, 'db', 'bridge')) ||
      fs.existsSync(path.join(dir, 'src', 'lib', 'services')) ||
      fs.existsSync(path.join(dir, 'src', 'app', 'api', 'mist'))
    )
  } catch {
    return false
  }
}

/** True when target is the bridge's own directory tree (wherever the user
 *  runs mist-bridge.js from — protects the bridge binary itself). */
function insideBridgeHome(target) {
  const bridgeHome = __dirname
  const t = path.resolve(target)
  return t === bridgeHome || t.startsWith(bridgeHome + path.sep)
}

/** Throw SelfModError when a WRITE-class target would modify the MIST project
 *  (detected by structure at the target or any ancestor up to home) or the
 *  bridge's own directory. Reads are never guarded — only this guard's callers
 *  (write/move/copy/delete/mkdir/zip/unzip) decide what counts as a write. */
class SelfModError extends Error {}
function guardSelfModification(target) {
  const t = path.resolve(target)
  if (insideBridgeHome(t)) {
    throw new SelfModError(
      'BLOCKED: that path is inside the Mist Bridge\'s own directory. The bridge never modifies itself — update it from Settings → Local Bridge.'
    )
  }
  // walk from the target's directory up to home, looking for a MIST project root
  let dir = fs.existsSync(t) && fs.statSync(t).isDirectory() ? t : path.dirname(t)
  while (true) {
    if (looksLikeMistProject(dir)) {
      throw new SelfModError(
        'BLOCKED SELF-MODIFICATION: that path is inside the MIST project (she detected ' +
          dir + '). I never write my own source directly — that is how I break myself. ' +
          'Use the evolution gate instead: mist_self_patch (backup-first, lint-gated, creator-approved, auto-rollback).'
      )
    }
    if (dir === HOME || path.dirname(dir) === dir) break
    dir = path.dirname(dir)
  }
}

/** Glob (* and ?) → anchored RegExp. Everything else is literal. */
function globToRegex(pattern) {
  let out = ''
  for (const ch of String(pattern)) {
    if (ch === '*') out += '[^/]*'
    else if (ch === '?') out += '[^/]'
    else out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`, 'i')
}

/** POSIX single-quote for shell args (safe: nothing escapes a single-quoted
 *  string; embedded quotes are closed-escaped-reopened). */
function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`
}

// ---------------- bridge config (persisted) ----------------

/** Read ~/.mist/bridge.json → object ({} when absent/unparsable). */
function readBridgeConfig() {
  try {
    return JSON.parse(fs.readFileSync(BRIDGE_CONFIG, 'utf-8'))
  } catch {
    return {}
  }
}

/** Merge-write ~/.mist/bridge.json (best-effort, never throws). */
function writeBridgeConfig(patch) {
  try {
    fs.mkdirSync(MIST_DIR, { recursive: true })
    const cur = readBridgeConfig()
    fs.writeFileSync(BRIDGE_CONFIG, JSON.stringify({ ...cur, ...patch }, null, 2), 'utf-8')
    return true
  } catch {
    return false
  }
}

// ---------------- process runner (safe argv) ----------------

/**
 * Spawn a command with an argv ARRAY (never a shell string) + hard timeout.
 * On win32, .cmd/.bat launchers can't be spawned directly — they are routed
 * through cmd.exe with only PRE-VALIDATED literal flags (callers must keep
 * user text out of argv; free text travels via files/stdin instead).
 */
function runArgv(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    const isCmdShim = PLATFORM === 'win32' && /\.(cmd|bat)$/i.test(cmd)
    const finalCmd = isCmdShim ? 'cmd.exe' : cmd
    const finalArgs = isCmdShim ? ['/d', '/s', '/c', cmd, ...args] : args
    let done = false
    let stdout = ''
    let stderr = ''
    let child
    try {
      child = spawn(finalCmd, finalArgs, {
        cwd: HOME,
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (err) {
      resolve({ ok: false, stdout: '', stderr: String((err && err.message) || err), code: null })
      return
    }
    const timer = setTimeout(() => {
      if (!done) {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }
    }, Math.max(1000, timeoutMs))
    child.stdout.on('data', (d) => {
      if (stdout.length < 400000) stdout += String(d)
    })
    child.stderr.on('data', (d) => {
      if (stderr.length < 200000) stderr += String(d)
    })
    child.on('error', (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: false, stdout, stderr: stderr + String(err.message || err), code: null, spawnError: true })
    })
    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: code === 0, stdout, stderr, code })
    })
  })
}

/** True when `bin --version` runs successfully (PATH probe, 8s). */
async function probeBinary(bin) {
  const res = await runArgv(bin, ['--version'], 8000)
  if (res.spawnError || res.code !== 0) return null
  return capOut(res.stdout.trim() || res.stderr.trim(), 200)
}

// ---------------- hermes ----------------

/** Hermes home dir (config/state/memories/skills live here). */
function hermesHome() {
  if (PLATFORM === 'win32') {
    const lad = process.env.LOCALAPPDATA
    if (lad) return path.join(lad, 'hermes')
  }
  return path.join(HOME, '.hermes')
}

/** Candidate Hermes repo-checkout folders (a git clone on this machine). */
function hermesRepoCandidates() {
  return [
    path.join(HOME, 'hermes'),
    path.join(HOME, 'hermes-agent'),
    path.join(HOME, 'my-agent', 'hermes'),
    path.join(HOME, 'my-agent', 'hermes-agent'),
    path.join(hermesHome(), 'hermes-agent'),
  ]
}

/** Looks like a hermes-agent checkout? (pyproject with the hermes script) */
function isHermesRepo(dir) {
  try {
    const py = fs.readFileSync(path.join(dir, 'pyproject.toml'), 'utf-8')
    return py.includes('hermes_cli.main:main') || py.includes('hermes-agent')
  } catch {
    return false
  }
}

/** ---- strict arg validators: anything that reaches argv must pass ---- */
const RE_THREAD = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const RE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._\/:-]{0,99}$/
const RE_LIST = /^[A-Za-z0-9_][A-Za-z0-9_,\s-]{0,199}$/ // comma/space separated ids
const RE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/
const RE_CRON_SCHEDULE = /^[^\n\r"'`&|<>^%]{1,80}$/

/**
 * Run `hermes <subcommand>` with safe argv. Free text (the task prompt)
 * MUST travel via `promptFile` (temp file), never the command line.
 */
async function hermesRun(args, timeoutMs) {
  return runArgv('hermes', args.map(String), Math.min(180000, Math.max(3000, timeoutMs || 90000)))
}

/** Write a temp file inside ~/.mist/tmp and return its path. */
function writeTempFile(name, content) {
  const dir = path.join(MIST_DIR, 'tmp')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${name}-${crypto.randomBytes(6).toString('hex')}.txt`)
  fs.writeFileSync(file, content, 'utf-8')
  return file
}

function removeTempFile(file) {
  try {
    fs.unlinkSync(file)
  } catch {
    /* best effort */
  }
}

/** ---- the hermes actions ---- */

async function hermesStatus() {
  const home = hermesHome()
  const version = await probeBinary('hermes')
  const repoPath = hermesRepoCandidates().find((d) => isHermesRepo(d)) || null
  const layout = {}
  for (const [key, rel] of [
    ['config', 'config.yaml'],
    ['stateDb', 'state.db'],
    ['memories', path.join('memories', 'MEMORY.md')],
    ['userProfile', path.join('memories', 'USER.md')],
    ['cronJobs', path.join('cron', 'jobs.json')],
  ]) {
    try {
      layout[key] = fs.statSync(path.join(home, rel)).size
    } catch {
      layout[key] = null
    }
  }
  let skillsCount = 0
  try {
    skillsCount = fs
      .readdirSync(path.join(home, 'skills'), { withFileTypes: true })
      .filter((e) => e.isDirectory()).length
  } catch {
    skillsCount = 0
  }
  // gateway API server probe (OpenAI-compatible surface, default :8642)
  let gatewayUp = false
  await new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: 8642, path: '/health', timeout: 1500 }, (res) => {
      gatewayUp = res.statusCode === 200
      res.resume()
      resolve()
    })
    req.on('timeout', () => {
      req.destroy()
      resolve()
    })
    req.on('error', () => resolve())
  })
  const installed = Boolean(version) || Boolean(repoPath) || layout.config !== null
  return {
    ok: true,
    installed,
    version: version || null,
    cliOnPath: Boolean(version),
    home,
    repoPath,
    gatewayUp,
    skillsCount,
    layout,
  }
}

async function hermesAsk(args) {
  const prompt = typeof args.prompt === 'string' ? args.prompt : ''
  if (!prompt.trim()) throw new Error('prompt is required')
  if (prompt.length > 60000) throw new Error('prompt exceeds the 60000-char limit')
  const timeoutMs = clampInt(args.timeoutMs, 90000, 5000, 150000)

  const argv = ['chat', '-Q', '--format', 'text', '--source', 'tool']
  const thread = str(args.thread)
  if (thread) {
    if (!RE_THREAD.test(thread)) throw new Error('thread may only contain letters, digits, dot, dash, underscore')
    argv.push('--create-if-missing', '-c', thread)
  }
  const resume = str(args.resume)
  if (resume) {
    if (!RE_ID.test(resume)) throw new Error('resume must be a session id')
    argv.push('--resume', resume)
  }
  const model = str(args.model)
  if (model) {
    if (!RE_MODEL.test(model)) throw new Error('model contains unsupported characters')
    argv.push('-m', model)
  }
  const toolsets = str(args.toolsets)
  if (toolsets) {
    if (!RE_LIST.test(toolsets)) throw new Error('toolsets may only be a comma-separated id list')
    argv.push('-t', toolsets)
  }
  const skills = str(args.skills)
  if (skills) {
    if (!RE_LIST.test(skills)) throw new Error('skills may only be a comma-separated id list')
    for (const s of skills.split(/[\s,]+/).filter(Boolean)) argv.push('-s', s)
  }

  const tmp = writeTempFile('hermes-prompt', prompt)
  argv.push('--query-file', tmp)
  try {
    const res = await hermesRun(argv, timeoutMs)
    // session id rides on stderr in quiet text mode — keep it when present
    const m = /session_id:\s*([A-Za-z0-9_-]+)/.exec(res.stderr || '')
    return {
      ok: res.ok && res.stdout.trim().length > 0,
      reply: capOut(res.stdout.trim(), 50000),
      sessionId: m ? m[1] : null,
      exitCode: res.code,
      stderrTail: capOut((res.stderr || '').trim().split('\n').slice(-4).join('\n'), 800),
    }
  } finally {
    removeTempFile(tmp)
  }
}

async function hermesSessions(args) {
  const limit = clampInt(args.limit, 10, 1, 50)
  const res = await hermesRun(['sessions', 'list', '--limit', String(limit)], 30000)
  return { ok: res.ok, table: capOut(res.stdout.trim(), 16000), stderrTail: capOut((res.stderr || '').trim(), 400) }
}

function hermesMemoryPath(which) {
  const file = which === 'user' ? 'USER.md' : 'MEMORY.md'
  return path.join(hermesHome(), 'memories', file)
}

async function hermesMemory(args) {
  const action = str(args.action) || 'read'
  const which = str(args.which) === 'user' ? 'user' : 'memory'
  const file = hermesMemoryPath(which)
  if (action === 'read') {
    let content = ''
    try {
      content = fs.readFileSync(file, 'utf-8')
    } catch {
      return { ok: true, which, exists: false, content: '' }
    }
    return { ok: true, which, exists: true, bytes: Buffer.byteLength(content, 'utf-8'), content: capOut(content, 16000) }
  }
  if (action === 'append') {
    const content = typeof args.content === 'string' ? args.content.trim() : ''
    if (!content) throw new Error('content is required for append')
    if (content.length > 2000) throw new Error('content exceeds the 2000-char budget')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // Hermes separates entries with a paragraph containing a single §
    let sep = '\n§\n'
    try {
      const cur = fs.readFileSync(file, 'utf-8')
      if (/\n§\s*\n\s*$/.test(cur) || /§\s*$/.test(cur.trimEnd())) sep = '\n'
      else if (!cur.trim()) sep = ''
    } catch {
      sep = ''
    }
    fs.appendFileSync(file, `${sep}${content}\n`, 'utf-8')
    return { ok: true, which, appended: content.length }
  }
  throw new Error(`unknown action: ${action} (use read|append)`)
}

/** Parse a SKILL.md frontmatter block into {name, description, version}. */
function parseSkillMd(text) {
  const m = /^---\n([\s\S]*?)\n---/.exec(text)
  const out = {}
  if (!m) return out
  for (const line of m[1].split('\n')) {
    const kv = /^([a-zA-Z_]+):\s*(.+)$/.exec(line)
    if (!kv) continue
    const key = kv[1].toLowerCase()
    if (key === 'name' || key === 'description' || key === 'version') out[key] = kv[2].trim()
  }
  return out
}

async function hermesSkills(args) {
  const action = str(args.action) || 'list'
  const skillsDir = path.join(hermesHome(), 'skills')
  if (action === 'list') {
    const skills = []
    try {
      for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || skills.length >= 200) continue
        try {
          const text = fs.readFileSync(path.join(skillsDir, entry.name, 'SKILL.md'), 'utf-8')
          const fm = parseSkillMd(text)
          skills.push({ name: fm.name || entry.name, description: fm.description || '', version: fm.version || null, dir: entry.name })
        } catch {
          /* not a skill dir */
        }
      }
    } catch {
      /* no skills dir */
    }
    return { ok: true, count: skills.length, skills }
  }
  if (action === 'export') {
    // Export a M.I.S.T. skill INTO Hermes: caller (Mist's backend) passes the
    // fully-composed SKILL.md content; we validate + write it under
    // ~/.hermes/skills/mist/<name>/ so it is discovered on Hermes' next start.
    const name = str(args.name)
    const content = typeof args.content === 'string' ? args.content : ''
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(name)) throw new Error('name must be lowercase-hyphen (2-64 chars)')
    if (!content.trim()) throw new Error('content (SKILL.md body) is required')
    if (content.length > 64000) throw new Error('content exceeds the 64KB limit')
    const dir = path.join(skillsDir, 'mist', name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf-8')
    return { ok: true, name, path: path.join(dir, 'SKILL.md'), note: 'discovered by Hermes on its next session start' }
  }
  throw new Error(`unknown action: ${action} (use list|export)`)
}

async function hermesCron(args) {
  const action = str(args.action) || 'list'
  if (action === 'list') {
    const res = await hermesRun(['cron', 'list'], 30000)
    return { ok: res.ok, table: capOut(res.stdout.trim(), 16000) }
  }
  if (action === 'add') {
    const name = str(args.name)
    const schedule = str(args.schedule)
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : ''
    if (!name || !RE_THREAD.test(name)) throw new Error('name must be a short slug (letters, digits, dash)')
    if (!schedule || !RE_CRON_SCHEDULE.test(schedule)) throw new Error('schedule is required (e.g. "every 30m", "0 9 * * *")')
    if (!prompt || prompt.length > 400 || /[\n\r"'`&|<>^%]/.test(prompt)) {
      throw new Error('prompt must be 1-400 chars of plain text without shell metacharacters')
    }
    const res = await hermesRun(['cron', 'add', schedule, '--prompt', prompt, '--name', name], 45000)
    return { ok: res.ok, output: capOut((res.stdout + res.stderr).trim(), 4000) }
  }
  if (action === 'run') {
    const jobId = str(args.jobId) || str(args.id)
    if (!RE_ID.test(jobId)) throw new Error('jobId is required')
    const res = await hermesRun(['cron', 'run', jobId], 30000)
    return { ok: res.ok, output: capOut((res.stdout + res.stderr).trim(), 4000) }
  }
  throw new Error(`unknown action: ${action} (use list|add|run)`)
}

// ---------------- companions ----------------

let companionsCache = null // {value, at}

/** Folder looks like a backtalk checkout? */
function isBacktalkDir(dir) {
  try {
    fs.statSync(path.join(dir, 'backtalk', 'main.py'))
    return true
  } catch {
    /* fallthrough */
  }
  try {
    fs.statSync(path.join(dir, 'backtalk.md'))
    return true
  } catch {
    return false
  }
}

/** Folder looks like an ai-visualizer checkout? */
function isVisualizerDir(dir) {
  try {
    fs.statSync(path.join(dir, 'server.py'))
    fs.statSync(path.join(dir, 'faces'))
    return true
  } catch {
    return false
  }
}

/** Folder looks like a barehands checkout? */
function isBarehandsDir(dir) {
  for (const marker of ['barehands.md', 'package.json', 'index.html']) {
    try {
      fs.statSync(path.join(dir, marker))
      return true
    } catch {
      /* keep looking */
    }
  }
  return false
}

/** Find a companion folder by NAME (direct child of home or of ~/my-agent). */
function findCompanionDir(name, testFn) {
  const roots = [HOME, path.join(HOME, 'my-agent')]
  for (const root of roots) {
    const dir = path.join(root, name)
    try {
      if (fs.statSync(dir).isDirectory() && (!testFn || testFn(dir))) return dir
    } catch {
      /* not there */
    }
  }
  return null
}

/** Resolve the signal-bus directory (persisted → visualizer → ~/.mist/signals). */
function resolveSignalDir(explicit) {
  if (explicit) {
    return { dir: jailPath(explicit), source: 'explicit' }
  }
  const cfg = readBridgeConfig()
  if (cfg && typeof cfg.signalDir === 'string' && cfg.signalDir) {
    try {
      const dir = jailPath(cfg.signalDir)
      fs.statSync(dir)
      return { dir, source: 'configured' }
    } catch {
      /* stale config — fall through */
    }
  }
  const viz = findCompanionDir('ai-visualizer', isVisualizerDir)
  if (viz) {
    return { dir: viz, source: 'ai-visualizer' }
  }
  return { dir: path.join(MIST_DIR, 'signals'), source: 'mist-default' }
}

/** Detect the whole local agent stack (cached 60s in-memory). */
async function companions() {
  if (companionsCache && Date.now() - companionsCache.at < 60000) return companionsCache.value

  const [hermes, claude] = await Promise.all([hermesStatus(), probeBinary('claude')])

  const backtalkDir = findCompanionDir('backtalk', isBacktalkDir)
  const vizDir = findCompanionDir('ai-visualizer', isVisualizerDir)
  const barehandsDir = findCompanionDir('barehands', isBarehandsDir)

  let vizFaces = []
  if (vizDir) {
    try {
      vizFaces = fs
        .readdirSync(path.join(vizDir, 'faces'), { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch {
      vizFaces = []
    }
  }

  const signal = resolveSignalDir()

  const value = {
    ok: true,
    hermes: {
      installed: hermes.installed,
      version: hermes.version,
      cliOnPath: hermes.cliOnPath,
      home: hermes.home,
      repoPath: hermes.repoPath,
      gatewayUp: hermes.gatewayUp,
      skillsCount: hermes.skillsCount,
    },
    backtalk: backtalkDir
      ? {
          installed: true,
          path: backtalkDir,
          hasVenv: fs.existsSync(path.join(backtalkDir, '.venv')),
          configured: fs.existsSync(path.join(backtalkDir, 'backtalk.json')),
        }
      : { installed: false, path: null },
    aiVisualizer: vizDir
      ? { installed: true, path: vizDir, faces: vizFaces }
      : { installed: false, path: null, faces: [] },
    barehands: barehandsDir
      ? { installed: true, path: barehandsDir }
      : { installed: false, path: null },
    claudeCode: { installed: Boolean(claude), version: claude || null },
    signal: { dir: signal.dir, source: signal.source },
    mcp: {
      registerCommand: `hermes mcp add mist --command node --args "${path.resolve(__filename)} --mcp"`,
    },
  }
  companionsCache = { value, at: Date.now() }
  return value
}

// ---------------- signal bus (backtalk / ai-visualizer contract) ----------------

const BUS_STATES = new Set(['idle', 'listening', 'thinking', 'speaking'])

async function signalSetup(args) {
  const explicit = str(args.dir) || null
  const resolved = resolveSignalDir(explicit)
  fs.mkdirSync(resolved.dir, { recursive: true })
  writeBridgeConfig({ signalDir: resolved.dir })
  companionsCache = null // re-detect with the new dir
  return { ok: true, dir: resolved.dir, source: resolved.source, persisted: true }
}

async function signalEmit(args) {
  const resolved = resolveSignalDir()
  fs.mkdirSync(resolved.dir, { recursive: true })
  const wrote = []

  const state = str(args.state).toLowerCase()
  if (state) {
    if (!BUS_STATES.has(state)) throw new Error(`state must be one of ${[...BUS_STATES].join('|')}`)
    fs.writeFileSync(path.join(resolved.dir, '.voice_state'), state, 'utf-8')
    wrote.push('state')
  }

  if (Array.isArray(args.samples) && args.samples.length > 0) {
    const samples = []
    for (let i = 0; i < 64; i++) {
      const v = Number(args.samples[i])
      samples.push(Number.isFinite(v) ? Math.max(-32768, Math.min(32767, Math.round(v))) : 0)
    }
    fs.writeFileSync(
      path.join(resolved.dir, '.voice_waveform'),
      JSON.stringify({ ts: Date.now() / 1000, samples }),
      'utf-8'
    )
    wrote.push('waveform')
  }

  if (typeof args.alert === 'boolean') {
    const alertFile = path.join(resolved.dir, '.voice_alert')
    if (args.alert) {
      fs.writeFileSync(alertFile, '1', 'utf-8')
      wrote.push('alert:on')
    } else {
      try {
        fs.unlinkSync(alertFile)
      } catch {
        /* already gone */
      }
      wrote.push('alert:off')
    }
  }

  if (typeof args.thinking === 'boolean') {
    const pidFile = path.join(resolved.dir, '.voice_loading_pid')
    if (args.thinking) {
      fs.writeFileSync(pidFile, String(process.pid), 'utf-8')
      wrote.push('thinking:on')
    } else {
      try {
        fs.unlinkSync(pidFile)
      } catch {
        /* already gone */
      }
      wrote.push('thinking:off')
    }
  }

  return { ok: true, dir: resolved.dir, wrote }
}

async function signalStatus() {
  const resolved = resolveSignalDir()
  const files = {}
  for (const name of ['.voice_state', '.voice_waveform', '.voice_alert', '.voice_loading_pid']) {
    try {
      const st = fs.statSync(path.join(resolved.dir, name))
      files[name] = { bytes: st.size, mtimeMs: Math.round(st.mtimeMs) }
    } catch {
      files[name] = null
    }
  }
  return { ok: true, dir: resolved.dir, source: resolved.source, files }
}

// ---------------- app discovery ----------------

/** Recursively collect files under dir (best-effort, capped). */
function walkFiles(dir, out) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return // unreadable dir — skip silently
  }
  for (const entry of entries) {
    if (out.files.length >= MAX_APPS_WALK) return
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(full, out)
    else if (entry.isFile()) out.files.push(full)
  }
}

/** Windows: Start Menu .lnk shortcuts (per-user + all-users). */
function listAppsWindows() {
  const roots = [process.env.APPDATA, process.env.ProgramData]
    .filter((r) => typeof r === 'string' && r.length > 0)
    .map((r) => path.join(String(r), 'Microsoft', 'Windows', 'Start Menu', 'Programs'))
  const out = { files: [] }
  for (const root of roots) {
    walkFiles(root, out)
    if (out.files.length >= MAX_APPS_WALK) break
  }
  return out.files
    .filter((f) => f.toLowerCase().endsWith('.lnk'))
    .map((f) => ({
      name: path.basename(f).replace(/\.lnk$/i, ''),
      path: f,
      kind: 'lnk',
    }))
}

/** macOS: /Applications and /Applications/Utilities .app bundles. */
function listAppsMac() {
  const apps = []
  for (const root of ['/Applications', '/Applications/Utilities']) {
    let entries
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (apps.length >= MAX_APPS_WALK) break
      if (entry.isDirectory() && entry.name.endsWith('.app')) {
        apps.push({
          name: entry.name.replace(/\.app$/, ''),
          path: path.join(root, entry.name),
          kind: 'app',
        })
      }
    }
  }
  return apps
}

/** Parse a .desktop entry → {name, path, kind, execLine} (or null when unusable). */
function parseDesktopEntry(file) {
  let text
  try {
    text = fs.readFileSync(file, 'utf-8')
  } catch {
    return null
  }
  let name = null
  let execLine = null
  let noDisplay = false
  for (const line of text.split('\n')) {
    if (line.startsWith('Name=')) name = line.slice(5).trim()
    else if (line.startsWith('Exec=')) execLine = line.slice(5).trim()
    else if (line.startsWith('NoDisplay=true')) noDisplay = true
  }
  if (!name || !execLine || noDisplay) return null
  return { name, path: file, kind: 'desktop', execLine }
}

/** Linux: .desktop entries from the user's and the system's applications dirs. */
function listAppsLinux() {
  const dirs = [
    path.join(HOME, '.local', 'share', 'applications'),
    '/usr/share/applications',
  ]
  const apps = []
  for (const dir of dirs) {
    let entries
    try {
      entries = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries.sort()) {
      if (apps.length >= MAX_APPS_WALK) break
      if (!entry.endsWith('.desktop')) continue
      const parsed = parseDesktopEntry(path.join(dir, entry))
      if (parsed) apps.push(parsed)
    }
  }
  return apps
}

/** Platform app list → [{name, path, kind, execLine?}] (internal shape). */
function listApps() {
  if (PLATFORM === 'win32') return listAppsWindows()
  if (PLATFORM === 'darwin') return listAppsMac()
  return listAppsLinux()
}

/** Strip freedesktop field codes (%f %u %F %U %i %c %k …) from an Exec line. */
function stripFieldCodes(execLine) {
  return execLine.replace(/%[fFuUdDnNickvm]/g, '').trim()
}

/** Best fuzzy match for a user query against the app list (null when nothing fits). */
function pickApp(apps, query) {
  const q = query.toLowerCase()
  if (!q) return null
  let best = null
  let bestScore = -1
  for (const app of apps) {
    const n = app.name.toLowerCase()
    let score = -1
    if (n === q) score = 100
    else if (n.startsWith(q)) score = 80
    else if (n.includes(q)) score = 60
    else if (q.includes(n)) score = 50
    if (score > bestScore) {
      bestScore = score
      best = app
    }
  }
  return bestScore >= 50 ? best : null
}

/** Closest human-readable app names for a miss (max 5). */
function suggestApps(apps, query, limit) {
  const q = query.toLowerCase()
  return apps
    .map((app) => ({ name: app.name, score: similarity(app.name.toLowerCase(), q) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit || 5)
    .map((s) => s.name)
}

/** Fire-and-forget launch of a discovered app (platform-specific). */
function launchApp(app) {
  if (PLATFORM === 'win32') {
    spawn('cmd', ['/c', 'start', '', app.path], { detached: true, shell: false, stdio: 'ignore' }).unref()
  } else if (PLATFORM === 'darwin') {
    spawn('open', ['-a', app.path], { detached: true, stdio: 'ignore' }).unref()
  } else {
    // Linux: re-read the .desktop entry and run its Exec line
    const parsed = parseDesktopEntry(app.path)
    if (!parsed) throw new Error(`could not read the desktop entry for ${app.name}`)
    const cmd = stripFieldCodes(parsed.execLine)
    if (!cmd) throw new Error(`the desktop entry for ${app.name} has no usable Exec line`)
    spawn('/bin/sh', ['-c', cmd], { detached: true, stdio: 'ignore' }).unref()
  }
}

// ---------------- voice (v3: local offline STT + TTS) ----------------
// Engines live under ~/.mist/voice:
//   bin/     whisper-cli(.exe), piper(.exe) + piper's espeak-ng dlls
//   models/  whisper ggml-*.bin
//   voices/  piper *.onnx + *.onnx.json
// Everything is spawned from bin/ by ABSOLUTE PATH — never from PATH.

const VOICE_DIR = path.join(MIST_DIR, 'voice')
const VOICE_BIN_DIR = path.join(VOICE_DIR, 'bin')
const VOICE_MODELS_DIR = path.join(VOICE_DIR, 'models')
const VOICE_VOICES_DIR = path.join(VOICE_DIR, 'voices')
const VOICE_CONFIG = path.join(VOICE_DIR, 'voice-config.json')

/** Download hosts allowed for voice engine files (hardcoded — no user input).
 *  github release assets redirect to objects/release-assets.githubusercontent.com;
 *  HF redirects to its own xet/LFS CDNs, so the whole first-party
 *  *.hf.co / *.huggingface.co family is accepted — nothing else. */
const VOICE_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'api.github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'huggingface.co',
  'cdn-lfs.huggingface.co',
  'cdn-lfs-us-1.huggingface.co',
])
const VOICE_DOWNLOAD_HOST_SUFFIXES = ['.huggingface.co', '.hf.co']

function voiceDownloadHostAllowed(hostname) {
  if (VOICE_DOWNLOAD_HOSTS.has(hostname)) return true
  return VOICE_DOWNLOAD_HOST_SUFFIXES.some((sfx) => hostname.endsWith(sfx))
}

/** Per-tier engine files: light = weak laptops, balanced = normal machines. */
const VOICE_TIERS = {
  light: {
    sttModel: 'ggml-tiny.en-q8_0.bin', // ~44MB
    ttsVoice: 'en_US-amy-low', // ~25MB
  },
  balanced: {
    sttModel: 'ggml-base.en-q8_0.bin', // ~85MB
    ttsVoice: 'en_US-lessac-medium', // ~63MB
  },
}

/** Strict voice-id validator — anything that reaches piper's --model argv. */
const RE_VOICE_ID = /^en_[A-Z]{2}(-[a-z]+)?-(low|medium|x_low)$/

let voiceSetupBusy = false
let voiceVersionCache = null // {value, at} — whisper --version probe

/** Hardware snapshot + the tier recommended for it (≤2 cpus or ≤5GB → light). */
function voiceHardware() {
  const cpus = os.cpus().length
  const memGb = Math.round((os.totalmem() / 1024 ** 3) * 10) / 10
  const recommended = cpus <= 2 || memGb <= 5 ? 'light' : 'balanced'
  return { cpus, memGb, recommended }
}

/** ggml-tiny.en-q8_0.bin → tiny.en (short label for reason sentences). */
function shortSttModel(name) {
  return String(name).replace(/^ggml-/, '').replace(/\.bin$/, '').replace(/-q8_0$/, '')
}

/** en_US-amy-low → amy (short label for reason sentences). */
function shortTtsVoice(id) {
  const m = /^([a-z]{2}_[A-Z]{2})-([a-z]+)-(.+)$/.exec(id)
  return m ? m[2] : id
}

/**
 * The recommended voice tier for THIS machine, explaining itself in one
 * human sentence — so "Mist, upgrade your voice" shows its reasoning.
 */
function recommendedVoiceTier() {
  const cpus = os.cpus().length
  const memGb = Math.round((os.totalmem() / 1024 ** 3) * 10) / 10
  const light = cpus <= 2 || memGb <= 5
  const tier = light ? 'light' : 'balanced'
  const spec = VOICE_TIERS[tier]
  const reason = light
    ? `${cpus} cores · ${memGb}GB ram — kept light so speech stays instant: ${shortSttModel(spec.sttModel)} + ${shortTtsVoice(spec.ttsVoice)}`
    : `${cpus} cores · ${memGb}GB ram — comfortably runs ${shortSttModel(spec.sttModel)} + ${shortTtsVoice(spec.ttsVoice)}`
  return { tier, reason }
}

/** Read ~/.mist/voice/voice-config.json → object ({} when absent). */
function readVoiceConfig() {
  try {
    return JSON.parse(fs.readFileSync(VOICE_CONFIG, 'utf-8'))
  } catch {
    return {}
  }
}

/** Merge-write ~/.mist/voice/voice-config.json (best-effort, never throws). */
function writeVoiceConfig(patch) {
  try {
    fs.mkdirSync(VOICE_DIR, { recursive: true })
    const cur = readVoiceConfig()
    fs.writeFileSync(VOICE_CONFIG, JSON.stringify({ ...cur, ...patch }, null, 2), 'utf-8')
    return true
  } catch {
    return false
  }
}

function whisperBinPath() {
  return path.join(VOICE_BIN_DIR, PLATFORM === 'win32' ? 'whisper-cli.exe' : 'whisper-cli')
}

function piperBinPath() {
  return path.join(VOICE_BIN_DIR, PLATFORM === 'win32' ? 'piper.exe' : 'piper')
}

/** Friendly label for a piper voice id: en_US-amy-low → "Amy (low)". */
function voiceLabel(id) {
  const m = /^([a-z]{2}_[A-Z]{2})-([a-z]+)-(.+)$/.exec(id)
  if (!m) return id
  return `${m[2].charAt(0).toUpperCase()}${m[2].slice(1)} (${m[3].replace(/_/g, ' ')})`
}

/** Find the installed whisper model (configured one wins, else any ggml-*.bin). */
function findWhisperModel() {
  const cfg = readVoiceConfig()
  const prefer = typeof cfg.sttModel === 'string' ? cfg.sttModel : null
  let names = []
  try {
    names = fs
      .readdirSync(VOICE_MODELS_DIR)
      .filter((n) => /^ggml-[\w.-]+\.bin$/i.test(n))
      .sort()
  } catch {
    return null
  }
  if (prefer && names.includes(prefer)) names = [prefer, ...names.filter((n) => n !== prefer)]
  if (names.length === 0) return null
  try {
    const p = path.join(VOICE_MODELS_DIR, names[0])
    return { path: p, name: path.basename(p), size: fs.statSync(p).size }
  } catch {
    return null
  }
}

/** Find the installed piper voice (configured one wins, else any voice
 *  .onnx across ALL known dirs — adopted foreign voices included). */
function findPiperVoice() {
  const cfg = readVoiceConfig()
  const prefer = typeof cfg.ttsVoice === 'string' ? cfg.ttsVoice : null
  const entries = []
  for (const dir of voiceDirs(cfg)) {
    let names = []
    try {
      names = fs
        .readdirSync(dir)
        .filter((n) => /^[a-z]{2}_[\w.-]+\.onnx$/i.test(n) && fs.existsSync(path.join(dir, `${n}.json`)))
        .sort()
    } catch {
      continue
    }
    for (const n of names) {
      const id = n.replace(/\.onnx$/, '')
      if (!RE_VOICE_ID_ANY.test(id)) continue
      const m = /^([a-z]{2}_[A-Z]{2})-([a-z0-9_]+)-/.exec(id)
      entries.push({ id, name: m ? m[2] : id, dir })
    }
  }
  if (entries.length === 0) return null
  if (prefer) {
    const hit = entries.find((e) => e.id === prefer)
    if (hit) return hit
  }
  return entries[0]
}

/** Absolute-path temp file inside ~/.mist/tmp. */
function voiceTmpPath(prefix, ext) {
  const dir = path.join(MIST_DIR, 'tmp')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${prefix}-${crypto.randomBytes(5).toString('hex')}${ext || ''}`)
}

function removeDirBestEffort(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* best effort */
  }
}

/**
 * Download `urlStr` to `destPath` over https with redirect following.
 * - host allowlist enforced at EVERY hop; non-https rejected
 * - up to 5 redirects
 * - 90s idle timeout, 500MB hard cap
 * - rejects bodies smaller than minBytes (likely an HTML error page)
 * Resolves {bytes, url}. Zero npm dependencies (https module only).
 */
function downloadToFile(urlStr, destPath, minBytes) {
  return new Promise((resolve, reject) => {
    let settled = false // one resolve/reject per download, redirects included
    const hop = (url, redirectsLeft) => {
      let parsed
      try {
        parsed = new URL(url)
      } catch {
        if (!settled) { settled = true; reject(new Error(`invalid download URL: ${url}`)) }
        return
      }
      if (parsed.protocol !== 'https:') {
        if (!settled) { settled = true; reject(new Error('voice downloads must use https')) }
        return
      }
      if (!voiceDownloadHostAllowed(parsed.hostname)) {
        if (!settled) { settled = true; reject(new Error(`download host not allowed: ${parsed.hostname}`)) }
        return
      }
      const req = https.request(
        parsed,
        {
          method: 'GET',
          headers: {
            'User-Agent': `mist-bridge/${VERSION}`,
            Accept: 'application/octet-stream, application/json, application/zip, application/gzip, */*',
          },
          timeout: 90000,
        },
        (res) => {
          const status = res.statusCode || 0
          if (status >= 300 && status < 400 && res.headers.location) {
            res.resume()
            if (redirectsLeft <= 0) {
              if (!settled) { settled = true; reject(new Error('too many download redirects')) }
              return
            }
            let next
            try {
              next = new URL(res.headers.location, parsed).toString()
            } catch {
              if (!settled) { settled = true; reject(new Error('redirect carried an invalid Location')) }
              return
            }
            hop(next, redirectsLeft - 1)
            return
          }
          if (status !== 200) {
            res.resume()
            if (!settled) {
              settled = true
              reject(new Error(`download failed: HTTP ${status} from ${parsed.hostname}`))
            }
            return
          }
          const len = Number.parseInt(String(res.headers['content-length'] || ''), 10)
          if (Number.isFinite(len) && len < minBytes) {
            res.resume()
            if (!settled) {
              settled = true
              reject(new Error(`download too small (${len}B) — the server likely returned an error page`))
            }
            return
          }
          const partPath = `${destPath}.part`
          let bytes = 0
          let failed = false
          const out = fs.createWriteStream(partPath)
          const fail = (err) => {
            if (failed) return
            failed = true
            settled = true
            try {
              out.destroy()
            } catch {
              /* ignore */
            }
            try {
              res.destroy()
            } catch {
              /* ignore */
            }
            try {
              fs.unlinkSync(partPath)
            } catch {
              /* ignore */
            }
            reject(err instanceof Error ? err : new Error(String(err)))
          }
          res.on('data', (d) => {
            if (failed) return
            bytes += d.length
            if (bytes > 500 * 1024 * 1024) {
              fail(new Error('download exceeded the 500MB safety cap'))
              return
            }
            if (!out.write(d)) {
              // backpressure — wait for the drain before pulling more (keeps
              // big models from buffering wholly in RAM on weak machines)
              res.pause()
              out.once('drain', () => {
                try {
                  res.resume()
                } catch {
                  /* already gone */
                }
              })
            }
          })
          res.on('error', fail)
          out.on('error', fail)
          res.on('end', () => {
            if (failed) return
            out.end(() => {
              if (bytes < minBytes) {
                fail(new Error(`download too small (${bytes}B) — expected a real engine file`))
                return
              }
              try {
                fs.renameSync(partPath, destPath)
              } catch (err) {
                fail(err)
                return
              }
              settled = true
              resolve({ bytes, url: parsed.toString() })
            })
          })
        }
      )
      req.on('timeout', () => req.destroy(new Error('download timed out (90s without data)')))
      req.on('error', (err) => {
        if (!settled) {
          settled = true
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
      req.end()
    }
    hop(urlStr, 5)
  })
}

/** GET JSON (≤2MB) with the same allowlist + redirect rules. */
async function downloadJson(urlStr) {
  const tmp = voiceTmpPath('voice-json', '.json')
  try {
    await downloadToFile(urlStr, tmp, 16)
    return JSON.parse(fs.readFileSync(tmp, 'utf-8'))
  } finally {
    removeTempFile(tmp)
  }
}

/**
 * Magic-byte sanity check on a downloaded file so an HTML error page or a
 * truncated LFS pointer can never be mistaken for an engine file.
 */
function validateDownloadKind(file, kind) {
  const fd = fs.openSync(file, 'r')
  try {
    const head = Buffer.alloc(8)
    const n = fs.readSync(fd, head, 0, head.length, 0)
    const h = head.slice(0, Math.max(0, n))
    if (h.length > 0 && h[0] === 0x3c) throw new Error('downloaded file looks like an HTML error page')
    if (kind === 'zip' && h.slice(0, 2).toString('latin1') !== 'PK') {
      throw new Error('downloaded file is not a zip archive')
    }
    if (kind === 'targz' && !(h[0] === 0x1f && h[1] === 0x8b)) {
      throw new Error('downloaded file is not a gzip archive')
    }
    if (kind === 'ggml') {
      // ggml magic 0x67676d6c stored little-endian → bytes "lmgg"
      const magic = h.length >= 4 ? h.readUInt32LE(0) : 0
      if (magic !== 0x67676d6c) throw new Error('downloaded model is not a ggml whisper model')
    }
  } finally {
    try {
      fs.closeSync(fd)
    } catch {
      /* ignore */
    }
  }
}

/** Pick the right whisper.cpp release asset for this platform. */
function pickWhisperAsset(assets) {
  if (PLATFORM === 'win32') {
    return (
      assets.find((a) => /whisper-bin-x64\.zip$/i.test(a.name)) ||
      assets.find((a) => a.name.includes('bin-x64')) ||
      null
    )
  }
  if (PLATFORM === 'darwin') {
    // upstream ships no prebuilt macOS CLI binary — only xcframeworks
    return null
  }
  // linux: arm64 machines take the arm build, x64 takes ubuntu-x64
  if (/arm64|aarch64/i.test(os.arch())) {
    const arm = assets.find((a) => /whisper-bin-arm64/i.test(a.name))
    if (arm) return arm
  }
  return (
    assets.find((a) => /ubuntu/i.test(a.name) && /x64|x86_64/i.test(a.name)) ||
    assets.find((a) => /ubuntu/i.test(a.name)) ||
    assets.find((a) => /whisper-bin-arm64/i.test(a.name)) ||
    null
  )
}

/**
 * Resolve a whisper.cpp binary download URL. The NEWEST release often ships
 * source only (v1.9.1+ dropped prebuilts), so the last few releases are
 * scanned in order until one carries an asset for this platform. When the
 * GitHub API is unreachable/rate-limited, a known-good tagged asset is used
 * directly instead (same allowlisted host).
 */
async function whisperReleaseAssetUrl() {
  try {
    const rels = await downloadJson(
      'https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=15'
    )
    if (Array.isArray(rels)) {
      for (const rel of rels) {
        const assets = Array.isArray(rel && rel.assets)
          ? rel.assets.filter(
              (a) => a && typeof a.name === 'string' && typeof a.browser_download_url === 'string'
            )
          : []
        const picked = pickWhisperAsset(assets)
        if (picked) return picked.browser_download_url
      }
    }
  } catch (err) {
    // API rate-limited or unreachable — fall through to the pinned asset
  }
  if (PLATFORM === 'win32') {
    return 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.0/whisper-bin-x64.zip'
  }
  if (PLATFORM === 'darwin') {
    throw new Error(
      `no prebuilt whisper.cpp binary for macOS — build it from source ` +
        `(https://github.com/ggml-org/whisper.cpp) and place whisper-cli in ${VOICE_BIN_DIR}`
    )
  }
  return /arm64|aarch64/i.test(os.arch())
    ? 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.0/whisper-bin-ubuntu-arm64.tar.gz'
    : 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.0/whisper-bin-ubuntu-x64.tar.gz'
}

/**
 * Piper release archives for this platform. rhasspy/piper's final
 * all-platforms release is 2023.11.14-2 (v1.x tags only carry Linux builds).
 */
function piperArchiveUrl() {
  const base = 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2'
  if (PLATFORM === 'win32') {
    return `${base}/piper_windows_amd64.zip`
  }
  if (PLATFORM === 'darwin') {
    return /arm64|aarch64/i.test(os.arch())
      ? `${base}/piper_macos_aarch64.tar.gz`
      : `${base}/piper_macos_x64.tar.gz`
  }
  return /arm64|aarch64/i.test(os.arch())
    ? `${base}/piper_linux_aarch64.tar.gz`
    : `${base}/piper_linux_x86_64.tar.gz`
}

/** piper voice id → its huggingface download URL (en_US-amy-low → .../en/en_US/amy/low/...). */
function piperVoiceUrl(voiceId, ext) {
  const m = /^([a-z]{2}_[A-Z]{2})-([a-z]+)-(.+)$/.exec(voiceId)
  if (!m) throw new Error(`cannot map voice id to a download path: ${voiceId}`)
  const file = `${voiceId}${ext}`
  return `https://huggingface.co/rhasspy/piper-voices/resolve/main/${m[1].split('_')[0]}/${m[1]}/${m[2]}/${m[3]}/${file}`
}

/** Extract an archive with the platform shell (win: Expand-Archive; linux/mac:
 *  tar for .tar.gz, unzip→tar fallback for .zip). */
async function extractArchive(archivePath, destDir) {
  fs.mkdirSync(destDir, { recursive: true })
  const isTar = /\.(tar\.gz|tgz|tar)$/i.test(archivePath)
  if (PLATFORM === 'win32') {
    // paths are bridge-generated (inside ~/.mist) — safe to embed, still quoted
    return runArgv(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -Force '${archivePath}' '${destDir}'`],
      180000
    )
  }
  if (isTar) return runArgv('tar', ['-xf', archivePath, '-C', destDir], 180000)
  const unzip = await runArgv('unzip', ['-o', archivePath, '-d', destDir], 180000)
  if (unzip.ok) return unzip
  // no unzip on the machine (or it failed) — bsdtar handles zips too
  return runArgv('tar', ['-xf', archivePath, '-C', destDir], 180000)
}

/** Depth-limited file search inside an extracted tree. */
function findFileDeep(dir, name, depth) {
  if (depth > 6) return null
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const e of entries) {
    if (e.isFile() && e.name === name) return path.join(dir, e.name)
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const found = findFileDeep(path.join(dir, e.name), name, depth + 1)
      if (found) return found
    }
  }
  return null
}

/** Recursively merge srcDir into destDir (files + subdirectories). */
function mergeTreeInto(srcDir, destDir, depth) {
  if (depth > 6) return
  fs.mkdirSync(destDir, { recursive: true })
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const from = path.join(srcDir, entry.name)
    const to = path.join(destDir, entry.name)
    if (entry.isDirectory()) mergeTreeInto(from, to, depth + 1)
    else if (entry.isFile()) fs.copyFileSync(from, to)
    else if (entry.isSymbolicLink()) {
      try {
        const target = fs.realpathSync(from)
        if (fs.statSync(target).isDirectory()) mergeTreeInto(target, to, depth + 1)
        else fs.copyFileSync(target, to)
      } catch {
        /* broken link — skip */
      }
    }
  }
}

/**
 * Hoist a binary out of an extracted archive tree into ~/.mist/voice/bin.
 * The archive layout varies (whisper: Release/…, piper: piper/…), so the
 * tree is searched for the binary and its whole containing folder is merged
 * into bin/ — that carries piper's espeak-ng dlls AND its espeak-ng-data/
 * dictionary directory, which must sit next to the executable.
 */
function hoistBinaryTree(rootDir, binName) {
  const found = findFileDeep(rootDir, binName, 0)
  if (!found) throw new Error(`${binName} not found inside the extracted archive`)
  const srcDir = path.dirname(found)
  mergeTreeInto(srcDir, VOICE_BIN_DIR, 0)
  const dest = path.join(VOICE_BIN_DIR, binName)
  if (PLATFORM !== 'win32') {
    try {
      fs.chmodSync(dest, 0o755)
    } catch {
      /* best effort */
    }
  }
  return dest
}

async function voiceStatus() {
  const hw = voiceHardware()
  const rec = recommendedVoiceTier()
  const gpus = await probeGpus() // shared with system_watch (cached — see below)
  const cfg = readVoiceConfig()
  const tier = cfg.tier === 'light' || cfg.tier === 'balanced' ? cfg.tier : hw.recommended
  const bin = whisperBinPath()
  const hasBin = fs.existsSync(bin)
  const model = hasBin ? findWhisperModel() : null
  const piper = piperBinPath()
  const hasPiper = fs.existsSync(piper)
  const voice = hasPiper ? findPiperVoice() : null

  // best-effort version probe (some builds don't support --version — cached 10min)
  let version = null
  if (hasBin) {
    if (voiceVersionCache && Date.now() - voiceVersionCache.at < 600000) {
      version = voiceVersionCache.value
    } else {
      const res = await runArgv(bin, ['--version'], 6000)
      version = res.ok ? capOut((res.stdout + res.stderr).trim(), 80) : null
      voiceVersionCache = { value: version, at: Date.now() }
    }
  }

  return {
    ok: true,
    voice: {
      stt: {
        installed: Boolean(hasBin && model),
        binary: hasBin ? bin : null,
        model: model ? model.name : null,
        modelMb: model ? Math.round((model.size / 1024 / 1024) * 10) / 10 : null,
        ...(version ? { version } : {}),
        // adopted-engine state (voice_discover / voice_adopt)
        engine: cfg.sttEngine === 'faster-whisper' ? 'faster-whisper' : 'whisper-cpp',
        ...(cfg.sttEngine === 'faster-whisper'
          ? {
              fwPython: typeof cfg.fwPython === 'string' ? cfg.fwPython : null,
              fwPythonAlive: typeof cfg.fwPython === 'string' ? fs.existsSync(cfg.fwPython) : false,
              fwModel: typeof cfg.fwModel === 'string' ? cfg.fwModel : 'tiny',
            }
          : {}),
      },
      tts: {
        installed: Boolean(hasPiper && voice),
        binary: hasPiper ? piper : null,
        voice: voice ? voice.id : null,
        voiceName: voice ? voice.name : null,
        // adopted piper (e.g. the Hermes install) + extra voices dir
        ...(typeof cfg.piperBin === 'string' && fs.existsSync(cfg.piperBin) && cfg.piperBin !== piper
          ? { adoptedBinary: cfg.piperBin }
          : {}),
        ...(typeof cfg.extraVoicesDir === 'string' && fs.existsSync(cfg.extraVoicesDir)
          ? { extraVoicesDir: cfg.extraVoicesDir }
          : {}),
      },
      dir: VOICE_DIR,
      tier,
      hardware: {
        cpus: hw.cpus,
        memGb: hw.memGb,
        gpus,
        recommended: rec, // {tier, reason} — explains itself
      },
      ...(voiceSetupBusy ? { busy: true } : {}),
    },
  }
}

async function voiceSetup(args) {
  const engine = str(args.engine).toLowerCase()
  if (engine !== 'stt' && engine !== 'tts') throw new Error("engine must be 'stt' or 'tts'")
  if (voiceSetupBusy) throw new Error('a voice engine setup is already running — wait for it to finish')
  const rec = recommendedVoiceTier()
  const cfg = readVoiceConfig()
  const tierInput = str(args.tier).toLowerCase()
  // 'auto' (or omitted) → the best tier THIS machine can run; an explicit
  // light/balanced always wins; the persisted tier is the middle default
  const tier =
    tierInput === 'light' || tierInput === 'balanced'
      ? tierInput
      : tierInput === 'auto'
        ? rec.tier
        : cfg.tier === 'light' || cfg.tier === 'balanced'
          ? cfg.tier
          : rec.tier
  const spec = VOICE_TIERS[tier]
  voiceSetupBusy = true
  let downloaded = 0
  try {
    fs.mkdirSync(VOICE_BIN_DIR, { recursive: true })
    fs.mkdirSync(VOICE_MODELS_DIR, { recursive: true })
    fs.mkdirSync(VOICE_VOICES_DIR, { recursive: true })
    const installed = {}

    if (engine === 'stt') {
      // 1) whisper.cpp prebuilt binary from a GitHub release
      const binUrl = await whisperReleaseAssetUrl()
      const binKind = /\.(tar\.gz|tgz)$/i.test(binUrl) ? 'targz' : 'zip'
      const archExt = binKind === 'targz' ? '.tar.gz' : '.zip'
      const zipTmp = voiceTmpPath('voice-whisper', archExt)
      try {
        await downloadToFile(binUrl, zipTmp, 1024 * 1024)
        validateDownloadKind(zipTmp, binKind)
        downloaded += fs.statSync(zipTmp).size
        const staging = voiceTmpPath('voice-whisper-extract', '')
        fs.mkdirSync(staging, { recursive: true })
        try {
          const ex = await extractArchive(zipTmp, staging)
          if (!ex.ok) {
            throw new Error(`could not extract the whisper binary: ${capOut(ex.stderr || ex.stdout, 300)}`)
          }
          installed.binary = hoistBinaryTree(staging, PLATFORM === 'win32' ? 'whisper-cli.exe' : 'whisper-cli')
        } finally {
          removeDirBestEffort(staging)
        }
      } finally {
        removeTempFile(zipTmp)
      }
      // 2) the quantized model for this tier
      const modelUrl = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${spec.sttModel}`
      const modelTmp = voiceTmpPath('voice-model', '.bin')
      try {
        await downloadToFile(modelUrl, modelTmp, 1024 * 1024)
        validateDownloadKind(modelTmp, 'ggml')
        downloaded += fs.statSync(modelTmp).size
        fs.renameSync(modelTmp, path.join(VOICE_MODELS_DIR, spec.sttModel))
      } finally {
        removeTempFile(modelTmp)
      }
      installed.model = spec.sttModel
    } else {
      // 1) piper binary (its espeak-ng dlls ride along inside the archive)
      const archUrl = piperArchiveUrl()
      const archTmp = voiceTmpPath('voice-piper', archUrl.endsWith('.zip') ? '.zip' : '.tar.gz')
      try {
        await downloadToFile(archUrl, archTmp, 1024 * 1024)
        validateDownloadKind(archTmp, archUrl.endsWith('.zip') ? 'zip' : 'targz')
        downloaded += fs.statSync(archTmp).size
        const staging = voiceTmpPath('voice-piper-extract', '')
        fs.mkdirSync(staging, { recursive: true })
        try {
          const ex = await extractArchive(archTmp, staging)
          if (!ex.ok) {
            throw new Error(`could not extract piper: ${capOut(ex.stderr || ex.stdout, 300)}`)
          }
          installed.binary = hoistBinaryTree(staging, PLATFORM === 'win32' ? 'piper.exe' : 'piper')
        } finally {
          removeDirBestEffort(staging)
        }
      } finally {
        removeTempFile(archTmp)
      }
      // 2) the voice model (~25-65MB) + its tiny .onnx.json config (a few KB)
      for (const ext of ['.onnx', '.onnx.json']) {
        const url = piperVoiceUrl(spec.ttsVoice, ext)
        const tmp = voiceTmpPath('voice-piper-voice', ext)
        try {
          await downloadToFile(url, tmp, ext === '.onnx' ? 1024 * 1024 : 200)
          if (ext === '.onnx') downloaded += fs.statSync(tmp).size
          fs.renameSync(tmp, path.join(VOICE_VOICES_DIR, `${spec.ttsVoice}${ext}`))
        } finally {
          removeTempFile(tmp)
        }
      }
      installed.voice = spec.ttsVoice
    }

    writeVoiceConfig({
      tier,
      ...(engine === 'stt' ? { sttModel: spec.sttModel } : { ttsVoice: spec.ttsVoice }),
      createdAt: new Date().toISOString(),
    })
    voiceVersionCache = null // re-probe after a reinstall
    return {
      ok: true,
      engine,
      tier,
      installed,
      downloadedMb: Math.round((downloaded / 1024 / 1024) * 10) / 10,
    }
  } finally {
    voiceSetupBusy = false
  }
}

/** Spawn with an active stdin pipe (piper reads the text to speak from stdin). */
function runArgvStdin(cmd, args, stdinData, timeoutMs) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, {
        cwd: HOME,
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (err) {
      resolve({ ok: false, stdout: '', stderr: String((err && err.message) || err), code: null, spawnError: true })
      return
    }
    let done = false
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      if (!done) {
        try {
          child.kill('SIGKILL')
        } catch {
          /* already gone */
        }
      }
    }, Math.max(1000, timeoutMs))
    child.stdout.on('data', (d) => {
      if (stdout.length < 400000) stdout += String(d)
    })
    child.stderr.on('data', (d) => {
      if (stderr.length < 200000) stderr += String(d)
    })
    child.on('error', (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: false, stdout, stderr: stderr + String(err.message || err), code: null, spawnError: true })
    })
    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: code === 0, stdout, stderr, code })
    })
    child.stdin.on('error', () => {
      /* piper may exit before reading all of stdin — the close event decides */
    })
    child.stdin.end(stdinData)
  })
}

async function voiceStt(args) {
  const wavB64 = typeof args.wav_b64 === 'string' ? args.wav_b64.replace(/\s+/g, '') : ''
  if (!wavB64) throw new Error('wav_b64 is required')
  const buf = Buffer.from(wavB64, 'base64')
  if (buf.length === 0) throw new Error('wav_b64 decoded to nothing')
  if (buf.length > 12 * 1024 * 1024) throw new Error('wav_b64 exceeds the 12MB decoded limit')
  if (buf.slice(0, 4).toString('latin1') !== 'RIFF') throw new Error('wav_b64 is not a RIFF/WAVE payload')

  const cfg = readVoiceConfig()

  // ADOPTED ENGINE: faster-whisper (the user's own install — e.g. the one
  // Hermes uses). Falls through to whisper.cpp when the python is gone.
  if (cfg.sttEngine === 'faster-whisper' && typeof cfg.fwPython === 'string' && fs.existsSync(cfg.fwPython)) {
    const started = Date.now()
    const wavFile = voiceTmpPath('voice-in-fw', '.wav')
    fs.writeFileSync(wavFile, buf)
    try {
      const model = typeof cfg.fwModel === 'string' && cfg.fwModel.trim() ? cfg.fwModel.trim() : 'tiny'
      const res = await runArgv(cfg.fwPython, ['-c', FW_TRANSCRIBE_CODE, model, wavFile], 120000)
      if (res.ok) {
        // the LAST stdout line is our JSON
        const lines = String(res.stdout || '').trim().split(/\r?\n/)
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const j = JSON.parse(lines[i])
            if (typeof j.text === 'string') {
              return {
                ok: true,
                text: j.text.trim(),
                elapsedMs: Date.now() - started,
                engine: 'faster-whisper',
                model,
                ...(typeof j.language === 'string' ? { language: j.language } : {}),
              }
            }
          } catch {
            /* not the JSON line — keep walking back */
          }
        }
      }
      // faster-whisper failed — fall through to whisper.cpp if it exists
    } finally {
      removeTempFile(wavFile)
    }
  }

  const bin = whisperBinPath()
  const model = findWhisperModel()
  if (!fs.existsSync(bin) || !model) {
    return {
      ok: false,
      error: 'not-installed',
      hint:
        cfg.sttEngine === 'faster-whisper'
          ? 'the adopted faster-whisper python failed — run voice_discover to re-adopt, or voice_setup engine:stt for whisper.cpp'
          : 'run voice_setup engine:stt (or voice_discover to adopt your existing faster-whisper)',
    }
  }

  const started = Date.now()
  const wavFile = voiceTmpPath('voice-in', '.wav')
  const outBase = voiceTmpPath('voice-out', '')
  fs.writeFileSync(wavFile, buf)
  try {
    const threads = String(Math.max(1, os.cpus().length - 1))
    // NOTE: no -nt here — the timestamped [00:00:00.000 --> …] lines on stdout
    // are the primary parse target; -of <base> + -otxt writes <base>.txt as
    // the fallback. (with -nt the stdout lines lose their brackets AND the
    // txt fallback silently never fires — verified against whisper.cpp 1.9.0)
    const res = await runArgv(
      bin,
      ['-m', model.path, '-f', wavFile, '-t', threads, '-of', outBase, '-otxt'],
      120000
    )
    // primary: timestamped transcript lines on stdout ([00:00:00.000 --> …] text)
    let text = ''
    for (const line of String(res.stdout || '').split('\n')) {
      const m = /^\s*\[[^\]]*\]\s*(.+)$/.exec(line)
      if (m && m[1].trim()) text += (text ? ' ' : '') + m[1].trim()
    }
    // fallback: whisper's -otxt output file (pure transcript, no chatter)
    if (!text) {
      try {
        text = fs.readFileSync(`${outBase}.txt`, 'utf-8').replace(/\s+/g, ' ').trim()
      } catch {
        /* no output file either */
      }
    }
    if (!res.ok && !text) {
      return {
        ok: false,
        error: 'transcription failed',
        stderr: capOut(String(res.stderr || '').trim(), 500),
      }
    }
    return { ok: true, text, elapsedMs: Date.now() - started, model: model.name }
  } finally {
    removeTempFile(wavFile)
    removeTempFile(`${outBase}.txt`)
  }
}

async function voiceTts(args) {
  // piper reads ONE line of text from stdin — newlines collapse to spaces
  const text = String(typeof args.text === 'string' ? args.text : '').replace(/[\r\n]+/g, ' ').trim()
  if (!text) throw new Error('text is required')
  if (text.length > 1000) throw new Error('text exceeds the 1000-char limit (the client chunks)')

  const requested = str(args.voice)
  if (requested && !RE_VOICE_ID_ANY.test(requested)) {
    throw new Error('voice must look like en_US-amy-low (language_COUNTRY-name-quality) or be empty for the default')
  }

  const cfg = readVoiceConfig()
  const ownBin = piperBinPath()
  const bin = typeof cfg.piperBin === 'string' && fs.existsSync(cfg.piperBin) ? cfg.piperBin : ownBin
  if (!fs.existsSync(bin)) {
    return { ok: false, error: 'not-installed', hint: 'run voice_setup engine:tts (or voice_discover to adopt an existing piper)' }
  }
  let voiceId = requested
  if (!voiceId) {
    const found = findPiperVoice()
    if (!found) return { ok: false, error: 'not-installed', hint: 'run voice_setup engine:tts' }
    voiceId = found.id
  }
  const voicePath = resolveVoicePath(voiceId, cfg)
  if (!voicePath) {
    return { ok: false, error: 'not-installed', hint: `voice ${voiceId} not found in any known voices dir — run voice_voices for the list` }
  }

  const outWav = voiceTmpPath('voice-tts-out', '.wav')
  const res = await runArgvStdin(
    bin,
    ['--model', voicePath, '--output_file', outWav],
    Buffer.from(`${text}\n`, 'utf-8'),
    60000
  )
  try {
    if (!res.ok) {
      return { ok: false, error: 'synthesis failed', stderr: capOut(String(res.stderr || '').trim(), 500) }
    }
    const wav = fs.readFileSync(outWav)
    if (wav.length < 44) {
      return { ok: false, error: 'synthesis failed', stderr: 'piper produced no audio' }
    }
    return { ok: true, wav_b64: wav.toString('base64'), sampleRateHint: 22050, bytes: wav.length }
  } finally {
    removeTempFile(outWav)
  }
}

// ---------------- voice reuse (v3.6: adopt existing engines) ----------------
// The user may ALREADY have voice engines on this machine — faster-whisper
// installed for another agent (e.g. Hermes), a piper binary + voice files.
// voice_discover finds them, voice_adopt wires them into voice-config, and
// voiceStt/voiceTts prefer the adopted engines — Mist REUSES instead of
// downloading her own copies. voice_voices lists every selectable voice
// across all known dirs (language/accent/name/quality parsed), voice_select
// is the pick. No second download needed when a Hermes install already has it.

/** Piper voice ids are lang_COUNTRY-name-quality, e.g. en_US-amy-low,
 *  en_GB-alan-low, sw_KR? — anything matching this shape is selectable. */
const RE_VOICE_ID_ANY = /^[a-z]{2}_[A-Z]{2}-[a-z0-9_]+-(x_low|low|medium|high)$/

/** Human language names for the codes piper uses (fallback: the code). */
const LANG_NAMES = {
  en: 'English', fr: 'French', de: 'German', es: 'Spanish', pt: 'Portuguese',
  it: 'Italian', nl: 'Dutch', pl: 'Polish', ru: 'Russian', cs: 'Czech',
  ar: 'Arabic', fa: 'Persian', hi: 'Hindi', bn: 'Bengali', ta: 'Tamil',
  te: 'Telugu', zh: 'Chinese', ja: 'Japanese', ko: 'Korean', vi: 'Vietnamese',
  id: 'Indonesian', ms: 'Malay', th: 'Thai', tr: 'Turkish', sv: 'Swedish',
  no: 'Norwegian', da: 'Danish', fi: 'Finnish', hu: 'Hungarian', ro: 'Romanian',
  sk: 'Slovak', uk: 'Ukrainian', bg: 'Bulgarian', ca: 'Catalan', gl: 'Galician',
  hr: 'Croatian', sr: 'Serbian', sl: 'Slovenian', is: 'Icelandic', et: 'Estonian',
  ga: 'Irish', cy: 'Welsh', eu: 'Basque', af: 'Afrikaans', sw: 'Swahili',
  nn: 'Norwegian Nynorsk', be: 'Belarusian', el: 'Greek', he: 'Hebrew',
}

/** Parse 'en_US-amy-low' → {language, langCode, accent, name, quality}. */
function parseVoiceId(id) {
  const m = /^([a-z]{2})_([A-Z]{2})-([a-z0-9_]+)-(x_low|low|medium|high)$/.exec(id)
  if (!m) return null
  return {
    language: LANG_NAMES[m[1]] || m[1],
    langCode: m[1],
    accent: `${m[1]}_${m[2]}`,
    name: m[3],
    quality: m[4],
  }
}

/** Every dir piper voice files may live in (Mist's own + adopted extras). */
function voiceDirs(cfg) {
  const dirs = [VOICE_VOICES_DIR]
  if (typeof cfg.extraVoicesDir === 'string' && cfg.extraVoicesDir.trim()) {
    dirs.push(cfg.extraVoicesDir.trim())
  }
  return dirs
}

/** Resolve a voice id to an existing .onnx path across all voice dirs. */
function resolveVoicePath(voiceId, cfg) {
  if (!RE_VOICE_ID_ANY.test(voiceId)) return null
  for (const dir of voiceDirs(cfg)) {
    const p = path.join(dir, `${voiceId}.onnx`)
    if (fs.existsSync(p) && fs.existsSync(`${p}.json`)) return p
  }
  return null
}

/** Depth-limited, error-tolerant walk — used to find engine binaries and
 *  voice files under foreign installs (Hermes etc.). NEVER throws. */
function walkFor(root, predicate, maxDepth = 3, maxEntries = 4000) {
  const found = []
  let entries = 0
  const walk = (dir, depth) => {
    if (depth > maxDepth || entries > maxEntries) return
    let names = []
    try {
      names = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of names) {
      if (++entries > maxEntries) return
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.isSymbolicLink()) continue
        if (/^(node_modules|\.git|__pycache__|site-packages)$/.test(e.name)) continue
        walk(full, depth + 1)
      } else if (predicate(full, e.name)) {
        found.push(full)
      }
    }
  }
  try {
    walk(root, 0)
  } catch {
    /* unreadable root — nothing to find */
  }
  return found
}

/** Candidate python executables to probe for faster-whisper. Absolute paths
 *  only in the RESULT — a bridge daemon's PATH is minimal (learned live: the
 *  sandbox bridge couldn't see the user venv), so PATH lookups are resolved
 *  to their absolute executable via sys.executable before anything is
 *  reported. Sources: PATH pythons, system locations, common venv homes,
 *  Windows install dirs, and any venv python under a Hermes install. */
function candidatePythons() {
  const home = os.homedir()
  const seen = new Set()
  const out = []
  const push = (p, opts = {}) => {
    if (!p || seen.has(p)) return
    seen.add(p)
    out.push({ cmd: p, args: [], label: p, ...opts })
  }
  // PATH names — resolved to absolute later via sys.executable (probe first,
  // report only what answers with a real faster_whisper import)
  const pathNames = PLATFORM === 'win32' ? ['python', 'py'] : ['python3', 'python']
  for (const name of pathNames) {
    if (!seen.has(name)) {
      seen.add(name)
      out.push({ cmd: name, args: PLATFORM === 'win32' && name === 'py' ? ['-3'] : [], label: name, pathLookup: true })
    }
  }
  // absolute candidates that commonly exist
  if (PLATFORM === 'win32') {
    const roots = []
    if (process.env.LOCALAPPDATA) roots.push({ dir: path.join(process.env.LOCALAPPDATA, 'Programs', 'Python'), match: /^Python\d+/ })
    roots.push({ dir: 'C:\\', match: /^Python\d+/ })
    for (const root of roots) {
      try {
        for (const e of fs.readdirSync(root)) {
          if (root.match.test(e)) {
            const exe = path.join(root.dir, e, 'python.exe')
            if (fs.existsSync(exe)) push(exe)
          }
        }
      } catch {
        /* unreadable root */
      }
    }
  } else {
    for (const p of [
      '/usr/bin/python3',
      '/usr/local/bin/python3',
      '/opt/homebrew/bin/python3',
      path.join(home, '.venv', 'bin', 'python3'),
      path.join(home, '.venv', 'bin', 'python'),
      path.join(home, 'venv', 'bin', 'python3'),
      path.join(home, '.local', 'bin', 'python3'),
    ]) {
      if (fs.existsSync(p)) push(p)
    }
  }
  // Hermes venvs: ~/.hermes/**/python(.exe) — the user's "is it in the Hermes
  // environment or global?" question answered by probing BOTH
  for (const hermesRoot of hermesRoots()) {
    const bins = walkFor(
      hermesRoot,
      (full, name) => name === 'python' || name === 'python.exe' || name === 'python3',
      4
    )
    for (const b of bins.slice(0, 4)) push(b)
  }
  return out.slice(0, 10)
}

/** Known Hermes install roots on this machine (existing dirs only). */
function hermesRoots() {
  const home = os.homedir()
  const candidates = [
    path.join(home, '.hermes'),
    path.join(home, 'hermes-agent'),
    path.join(home, '.local', 'share', 'hermes'),
  ]
  if (PLATFORM === 'win32' && process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'hermes'))
    candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'hermes'))
  }
  return candidates.filter((p) => {
    try {
      return fs.statSync(p).isDirectory()
    } catch {
      return false
    }
  })
}

/** One probe = BOTH answers: the python's ABSOLUTE path (sys.executable —
 *  PATH names resolve here, daemon PATH is untrustworthy) and whether
 *  faster_whisper imports, with its version. */
const FW_PROBE_CODE =
  'import sys\ntry:\n import faster_whisper\n v=faster_whisper.__version__ or "0"\nexcept Exception:\n v=None\nsys.stdout.write(sys.executable+"|"+(v or ""))'

/** The one-shot python that transcribes with faster-whisper (JSON on stdout). */
const FW_TRANSCRIBE_CODE = [
  'import sys,json',
  'from faster_whisper import WhisperModel',
  "m=WhisperModel(sys.argv[1],device='cpu',compute_type='int8')",
  'segs,info=m.transcribe(sys.argv[2])',
  "print(json.dumps({'text':' '.join(s.text for s in segs).strip(),'language':info.language}))",
].join(';')

/** voice_discover: find faster-whisper pythons, piper binaries, and piper
 *  voice files that already exist on this machine (incl. Hermes installs). */
async function voiceDiscover() {
  const cfg = readVoiceConfig()

  // 1) faster-whisper across candidate pythons (each probe is timeout-capped;
  //    PATH names resolve to their ABSOLUTE executable inside the probe)
  const fasterWhisper = []
  for (const p of candidatePythons()) {
    try {
      const res = await runArgv(p.cmd, [...p.args, '-c', FW_PROBE_CODE], 12000)
      if (!res.ok) continue
      const [exe, ver] = String(res.stdout || '').trim().split('|')
      if (exe && ver) {
        // dedupe by resolved executable (PATH name + absolute path may collide)
        if (!fasterWhisper.some((f) => f.python === exe)) {
          fasterWhisper.push({ python: exe, version: capOut(ver, 40), via: p.label })
        }
      }
    } catch {
      /* this python doesn't have it */
    }
  }

  // 2) piper binaries: PATH + Hermes roots + common unix location
  const pipers = []
  try {
    const res = await runArgv(PLATFORM === 'win32' ? 'where' : 'which', ['piper'], 6000)
    for (const line of String(res.stdout || '').split(/\r?\n/)) {
      const t = line.trim()
      if (t && fs.existsSync(t)) pipers.push(t)
    }
  } catch {
    /* not on PATH */
  }
  for (const root of hermesRoots()) {
    for (const b of walkFor(root, (full, name) => /^piper(\.exe)?$/.test(name), 3)) {
      if (!pipers.includes(b)) pipers.push(b)
    }
  }
  const localBin = path.join(os.homedir(), '.local', 'bin', PLATFORM === 'win32' ? 'piper.exe' : 'piper')
  if (fs.existsSync(localBin) && !pipers.includes(localBin)) pipers.push(localBin)

  // 3) piper voice files (*.onnx + .onnx.json pairs) in foreign locations
  const foreignVoices = new Set()
  const voiceFileDirs = []
  const scanVoiceDir = (dir, origin) => {
    try {
      const names = fs.readdirSync(dir)
      const ids = names
        .filter((n) => n.endsWith('.onnx') && fs.existsSync(path.join(dir, `${n}.json`)))
        .map((n) => n.replace(/\.onnx$/, ''))
        .filter((id) => RE_VOICE_ID_ANY.test(id))
      if (ids.length > 0) {
        voiceFileDirs.push({ dir, origin, voices: ids.length })
        for (const id of ids) foreignVoices.add(id)
      }
    } catch {
      /* unreadable */
    }
  }
  for (const root of hermesRoots()) {
    for (const d of walkFor(root, (full) => /[\\/]voices$/.test(full), 3)) scanVoiceDir(d, 'hermes')
  }
  for (const b of pipers) scanVoiceDir(path.join(path.dirname(b), 'voices'), 'piper-install')
  scanVoiceDir(VOICE_VOICES_DIR, 'mist')

  return {
    ok: true,
    fasterWhisper,
    piper: pipers,
    voiceDirs: voiceFileDirs,
    foreignVoices: [...foreignVoices].sort(),
    mistVoiceInstalled: {
      whisperCpp: fs.existsSync(whisperBinPath()),
      piper: fs.existsSync(piperBinPath()),
    },
    adopted: {
      sttEngine: typeof cfg.sttEngine === 'string' ? cfg.sttEngine : 'whisper-cpp',
      fwPython: typeof cfg.fwPython === 'string' ? cfg.fwPython : null,
      piperBin: typeof cfg.piperBin === 'string' ? cfg.piperBin : null,
      extraVoicesDir: typeof cfg.extraVoicesDir === 'string' ? cfg.extraVoicesDir : null,
    },
    hint:
      'adopt what you found: voice_adopt {sttEngine:"faster-whisper",fwPython:"…"} and/or {piperBin:"…",extraVoicesDir:"…"} — Mist then reuses these instead of downloading her own copies',
  }
}

/** voice_adopt: wire discovered engines into voice-config (paths validated). */
function voiceAdopt(args) {
  const patch = {}
  if (args.sttEngine !== undefined) {
    const engine = String(args.sttEngine)
    if (engine !== 'whisper-cpp' && engine !== 'faster-whisper') {
      throw new Error("sttEngine must be 'whisper-cpp' or 'faster-whisper'")
    }
    patch.sttEngine = engine
  }
  if (args.fwPython !== undefined) {
    const p = String(args.fwPython)
    if (!fs.existsSync(p)) throw new Error(`fwPython path does not exist: ${p}`)
    patch.fwPython = p
    patch.sttEngine = 'faster-whisper'
  }
  if (args.fwModel !== undefined) {
    const m = String(args.fwModel).trim()
    if (!/^[\w.-]+$/.test(m)) throw new Error('fwModel must be a model name like tiny, base, small, large-v3')
    patch.fwModel = m
  }
  if (args.piperBin !== undefined) {
    const p = String(args.piperBin)
    if (!fs.existsSync(p)) throw new Error(`piperBin path does not exist: ${p}`)
    patch.piperBin = p
  }
  if (args.extraVoicesDir !== undefined) {
    const d = String(args.extraVoicesDir)
    const st = fs.statSync(d) // throws when missing — that's the validation
    if (!st.isDirectory()) throw new Error(`extraVoicesDir is not a directory: ${d}`)
    patch.extraVoicesDir = d
  }
  if (Object.keys(patch).length === 0) throw new Error('nothing to adopt — pass fwPython / piperBin / extraVoicesDir / sttEngine')
  writeVoiceConfig(patch)
  const cfg = readVoiceConfig()
  return { ok: true, adopted: cfg, note: 'voiceStt/voiceTts will now prefer the adopted engines' }
}

/** voice_voices: every selectable piper voice across all dirs, parsed. */
function voiceVoices() {
  const cfg = readVoiceConfig()
  const byId = new Map()
  for (const dir of voiceDirs(cfg)) {
    let names = []
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const n of names) {
      if (!n.toLowerCase().endsWith('.onnx')) continue
      const full = path.join(dir, n)
      if (!fs.existsSync(`${full}.json`)) continue
      const id = n.replace(/\.onnx$/, '')
      if (!RE_VOICE_ID_ANY.test(id)) continue
      const parsed = parseVoiceId(id)
      if (!parsed) continue
      byId.set(id, { id, dir, ...parsed })
    }
  }
  const selected = typeof cfg.ttsVoice === 'string' ? cfg.ttsVoice : (findPiperVoice() || {}).id || null
  return {
    ok: true,
    selected,
    count: byId.size,
    voices: [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)),
    naming: 'voice ids are language_COUNTRY-voiceName-quality, e.g. en_US-amy-medium (US English, Amy, medium size), en_GB-alan-low (British), en_ZA (South African accent)',
  }
}

/** voice_select: pick the active TTS voice / STT model / STT engine. */
function voiceSelect(args) {
  const cfg = readVoiceConfig()
  const patch = {}
  if (args.ttsVoice !== undefined) {
    const id = String(args.ttsVoice)
    if (!resolveVoicePath(id, cfg)) {
      throw new Error(`voice "${id}" not found in any known voices dir — run voice_voices for the list (and voice_discover to find foreign dirs first)`)
    }
    patch.ttsVoice = id
  }
  if (args.sttModel !== undefined) {
    const name = String(args.sttModel)
    if (!/^ggml-[\w.-]+\.bin$/i.test(name)) throw new Error('sttModel must look like ggml-base.en-q8_0.bin')
    if (!fs.existsSync(path.join(VOICE_MODELS_DIR, name))) throw new Error(`sttModel not installed: ${name}`)
    patch.sttModel = name
  }
  if (args.sttEngine !== undefined) {
    const engine = String(args.sttEngine)
    if (engine !== 'whisper-cpp' && engine !== 'faster-whisper') {
      throw new Error("sttEngine must be 'whisper-cpp' or 'faster-whisper'")
    }
    patch.sttEngine = engine
  }
  if (Object.keys(patch).length === 0) throw new Error('nothing to select — pass ttsVoice / sttModel / sttEngine')
  writeVoiceConfig(patch)
  const out = voiceVoices()
  return { ok: true, selected: out.selected, count: out.count, config: readVoiceConfig() }
}

// ---------------- system watch (v3.1: the machine guardian) ----------------
// One action = one full machine snapshot. EVERY probe is best-effort and
// individually timeout-capped: a laptop without thermal sensors, an
// admin-locked Security event log, or a container without /sys must still
// get a complete report with nulls — nothing here may throw or hang.
// PowerShell probes are always -NoProfile -NonInteractive -Command (text).

/** Run a PowerShell snippet with the strict profile-less flags + timeout. */
function psQuery(snippet, timeoutMs) {
  return runArgv('powershell', ['-NoProfile', '-NonInteractive', '-Command', snippet], timeoutMs)
}

/** First integer anywhere in a probe's stdout (null when absent). */
function firstInt(stdout) {
  const m = /-?\d+/.exec(String(stdout || ''))
  return m ? Number.parseInt(m[0], 10) : null
}

/** 1-min load average → % of all cores (clamped 0-100). */
function loadPctFromLoad(load) {
  const cores = Math.max(1, os.cpus().length)
  return Math.max(0, Math.min(100, Math.round((load / cores) * 100)))
}

/** CPU load % (0-100) — null when the platform probe fails. */
async function swCpuLoad() {
  try {
    if (PLATFORM === 'win32') {
      const res = await psQuery(
        'Get-CimInstance Win32_Processor | Select-Object -ExpandProperty LoadPercentage',
        12000
      )
      if (!res.ok) return null
      // one line per socket — average them, ignore junk lines
      const vals = String(res.stdout || '')
        .split(/\r?\n/)
        .map((l) => Number.parseInt(l.trim(), 10))
        .filter((n) => Number.isFinite(n) && n >= 0 && n <= 100)
      if (vals.length === 0) return null
      return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)
    }
    if (PLATFORM === 'darwin') {
      const res = await runArgv('sysctl', ['-n', 'vm.loadavg'], 8000)
      if (!res.ok) return null
      const m = /(\d+\.?\d*)/.exec(res.stdout || '')
      if (!m) return null
      return loadPctFromLoad(parseFloat(m[1]))
    }
    const text = fs.readFileSync('/proc/loadavg', 'utf-8')
    const load = parseFloat(text.split(/\s+/)[0])
    if (!Number.isFinite(load)) return null
    return loadPctFromLoad(load)
  } catch {
    return null
  }
}

/** RAM {usedPct, totalGb} — null when unavailable. */
async function swRam() {
  try {
    if (PLATFORM === 'win32') {
      // FreePhysicalMemory / TotalVisibleMemorySize are in KILOBYTES
      const res = await psQuery(
        "$os = Get-CimInstance Win32_OperatingSystem; Write-Output ($os.FreePhysicalMemory.ToString() + ' ' + $os.TotalVisibleMemorySize.ToString())",
        12000
      )
      if (!res.ok) return null
      const m = /(\d+)\s+(\d+)/.exec(res.stdout || '')
      if (!m) return null
      const freeKb = Number(m[1])
      const totalKb = Number(m[2])
      if (!totalKb) return null
      return {
        usedPct: Math.max(0, Math.min(100, Math.round((1 - freeKb / totalKb) * 100))),
        totalGb: Math.round((totalKb / 1024 / 1024) * 10) / 10,
      }
    }
    if (PLATFORM === 'darwin') {
      const [vm, memsize] = await Promise.all([
        runArgv('vm_stat', [], 8000),
        runArgv('sysctl', ['-n', 'hw.memsize'], 8000),
      ])
      if (!vm.ok || !memsize.ok) return null
      const total = Number.parseInt(String(memsize.stdout).trim(), 10)
      if (!Number.isFinite(total) || total <= 0) return null
      const psMatch = /page size of (\d+) bytes/i.exec(vm.stdout)
      const pageSize = psMatch ? Number.parseInt(psMatch[1], 10) : 4096
      const pages = (label) => {
        const m = new RegExp(`Pages ${label}: (\\d+)`).exec(vm.stdout)
        return m ? Number.parseInt(m[1], 10) : 0
      }
      const freeish = pages('free') + pages('inactive') + pages('speculative')
      const freePct = Math.max(0, Math.min(100, Math.round(((freeish * pageSize) / total) * 100)))
      return { usedPct: 100 - freePct, totalGb: Math.round((total / 1024 ** 3) * 10) / 10 }
    }
    // linux
    const info = {}
    for (const line of fs.readFileSync('/proc/meminfo', 'utf-8').split('\n')) {
      const m = /^(\w+):\s+(\d+)\s*kB/.exec(line)
      if (m) info[m[1]] = Number(m[2])
    }
    if (!info.MemTotal) return null
    const availKb = info.MemAvailable ?? info.MemFree ?? 0
    return {
      usedPct: Math.max(0, Math.min(100, Math.round((1 - availKb / info.MemTotal) * 100))),
      totalGb: Math.round((info.MemTotal / 1024 / 1024) * 10) / 10,
    }
  } catch {
    return null
  }
}

/** System-drive free space {freePct, totalGb} — null when unavailable. */
async function swDisk() {
  try {
    if (PLATFORM === 'win32') {
      const res = await psQuery(
        "Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DeviceID -eq $env:SystemDrive } | ForEach-Object { Write-Output ($_.FreeSpace.ToString() + ' ' + $_.Size.ToString()) }",
        12000
      )
      if (!res.ok) return null
      const m = /(\d+)\s+(\d+)/.exec(res.stdout || '')
      if (!m) return null
      const free = Number(m[1])
      const size = Number(m[2])
      if (!size) return null
      return {
        freePct: Math.max(0, Math.min(100, Math.round((free / size) * 100))),
        totalGb: Math.round((size / 1024 ** 3) * 10) / 10,
      }
    }
    // linux + mac: statfs on the root fs (df -k fallback for very old Node)
    if (typeof fs.statfsSync === 'function') {
      const st = fs.statfsSync('/')
      const total = st.blocks * st.bsize
      if (total > 0 && st.blocks > 0) {
        return {
          freePct: Math.max(0, Math.min(100, Math.round((st.bavail / st.blocks) * 100))),
          totalGb: Math.round((total / 1024 ** 3) * 10) / 10,
        }
      }
    }
    const res = await runArgv('df', ['-k', '/'], 8000)
    if (!res.ok) return null
    const cols = ((res.stdout || '').split(/\r?\n/)[1] || '').trim().split(/\s+/)
    const totalKb = Number(cols[1])
    const availKb = Number(cols[3])
    if (!Number.isFinite(totalKb) || totalKb <= 0) return null
    return {
      freePct: Math.max(0, Math.min(100, Math.round((availKb / totalKb) * 100))),
      totalGb: Math.round((totalKb / 1024 / 1024) * 10) / 10,
    }
  } catch {
    return null
  }
}

/** CPU temperature °C — null when sensors are missing/locked (very common). */
async function swThermal() {
  try {
    if (PLATFORM === 'win32') {
      // MSAcpi_ThermalZoneTemperature: tenths of Kelvin. Unsupported on most
      // consumer machines → empty/error → null, never a failure
      const res = await psQuery(
        '(Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature | Measure-Object -Property CurrentTemperature -Maximum).Maximum',
        10000
      )
      if (!res.ok) return null
      const tenthsK = firstInt(res.stdout)
      if (tenthsK === null || tenthsK <= 0) return null
      return Math.round((tenthsK / 10 - 273.15) * 10) / 10
    }
    if (PLATFORM === 'linux') {
      let best = null
      let zones = []
      try {
        zones = fs.readdirSync('/sys/class/thermal').filter((n) => /^thermal_zone\d+$/.test(n))
      } catch {
        return null
      }
      for (const zone of zones) {
        try {
          const milli = Number.parseInt(
            fs.readFileSync(`/sys/class/thermal/${zone}/temp`, 'utf-8').trim(),
            10
          )
          if (Number.isFinite(milli) && milli > 0) {
            const c = Math.round(milli / 100) / 10
            if (best === null || c > best) best = c
          }
        } catch {
          /* unreadable zone — skip it */
        }
      }
      return best
    }
    return null // mac: powermetrics needs sudo — stay honest with a null
  } catch {
    return null
  }
}

/** Battery {pct, charging} — null on desktops / unsupported platforms. */
async function swBattery() {
  try {
    if (PLATFORM === 'win32') {
      const res = await psQuery(
        "Get-CimInstance Win32_Battery | ForEach-Object { Write-Output ($_.EstimatedChargeRemaining.ToString() + ' ' + $_.BatteryStatus.ToString()) }",
        10000
      )
      if (!res.ok) return null
      const m = /(\d+)\s+(\d+)/.exec(res.stdout || '')
      if (!m) return null
      const pct = Number(m[1])
      // BatteryStatus 2 = running on AC (not discharging)
      return { pct: Math.max(0, Math.min(100, pct)), charging: Number(m[2]) === 2 }
    }
    if (PLATFORM === 'linux') {
      const base = '/sys/class/power_supply'
      let dirs = []
      try {
        dirs = fs.readdirSync(base)
      } catch {
        return null
      }
      const bats = dirs.filter((n) => /^BAT\d+$/.test(n)).sort()
      if (bats.length === 0) return null
      const pctRaw = Number.parseInt(
        fs.readFileSync(`${base}/${bats[0]}/capacity`, 'utf-8').trim(),
        10
      )
      if (!Number.isFinite(pctRaw)) return null
      let status = ''
      try {
        status = fs.readFileSync(`${base}/${bats[0]}/status`, 'utf-8').trim()
      } catch {
        /* status is optional */
      }
      let acOnline = false
      for (const ac of dirs.filter((n) => /^(AC|ADP|A)\d*$/.test(n))) {
        try {
          if (fs.readFileSync(`${base}/${ac}/online`, 'utf-8').trim() === '1') acOnline = true
        } catch {
          /* skip */
        }
      }
      return {
        pct: Math.max(0, Math.min(100, pctRaw)),
        charging: acOnline || status === 'Charging' || status === 'Full',
      }
    }
    return null // mac: ioreg parsing is heavier than it's worth — null
  } catch {
    return null
  }
}

/**
 * Security posture — every piece individually best-effort (never fails the
 * action): defender {realTimeProtection, antivirusEnabled, signaturesAgeDays}
 * | null; failedLogons24h number | null (null = unreadable, 0 = read + clean).
 */
async function swSecurity() {
  const out = { defender: null, failedLogons24h: null, source: null }
  try {
    if (PLATFORM === 'win32') {
      try {
        const res = await psQuery(
          "$s = Get-MpComputerStatus; if ($s) { $age = -1; if ($s.AntivirusSignatureLastUpdated) { $age = [math]::Round(((Get-Date) - $s.AntivirusSignatureLastUpdated).TotalDays, 1) }; Write-Output \"$($s.RealTimeProtectionEnabled) $($s.AntivirusEnabled) $age\" }",
          15000
        )
        if (res.ok) {
          const m = /(True|False)\s+(True|False)\s+(-?\d+(?:\.\d+)?)/i.exec(res.stdout || '')
          if (m) {
            out.defender = {
              realTimeProtection: /^true$/i.test(m[1]),
              antivirusEnabled: /^true$/i.test(m[2]),
              signaturesAgeDays: Number(m[3]) >= 0 ? Number(m[3]) : null,
            }
          }
        }
      } catch {
        /* Defender module absent → defender stays null */
      }
      try {
        // 4625 = failed logon. The Security log usually needs an elevated
        // shell: 'ERR' → null (honest unknown), never a false "0".
        const res = await psQuery(
          "$ev = Get-WinEvent -FilterHashtable @{LogName='Security';Id=4625} -MaxEvents 20 -ErrorAction SilentlyContinue -ErrorVariable e; if ($e) { Write-Output 'ERR' } elseif ($ev) { $ev | ForEach-Object { $_.TimeCreated.ToString('o') } } else { Write-Output 'NONE' }",
          15000
        )
        if (res.ok) {
          const text = String(res.stdout || '').trim()
          if (text === 'NONE') {
            out.failedLogons24h = 0
            out.source = 'eventlog'
          } else if (text && text !== 'ERR') {
            const since = Date.now() - 24 * 3600 * 1000
            let n = 0
            for (const line of text.split(/\r?\n/)) {
              const t = Date.parse(line.trim())
              if (Number.isFinite(t) && t >= since) n++
            }
            out.failedLogons24h = n
            out.source = 'eventlog'
          }
        }
      } catch {
        /* admin-locked event log → null */
      }
    } else if (PLATFORM === 'linux') {
      try {
        const res = await runArgv('journalctl', ['-u', 'ssh', '--since', '24 hours ago', '--no-pager'], 15000)
        if (res.spawnError || !res.ok) return out // no journalctl / no permission
        const text = `${res.stdout || ''}\n${res.stderr || ''}`
        // A non-root user without journal-group membership sees only their own
        // messages — that would silently undercount, so report null instead.
        if (/Hint: You are currently not seeing/i.test(text)) return out
        // "No journal files were found" = nothing observable — also null
        if (/No journal files were found/i.test(text)) return out
        const n = (text.match(/Failed \S+ for|Invalid user|authentication failure/gi) || []).length
        out.failedLogons24h = n
        out.source = 'journal'
      } catch {
        /* journalctl absent → null */
      }
    }
  } catch {
    /* never fail the whole action */
  }
  return out
}

/** Top processes by CPU — [{name, cpuPct?}] (+cpuSeconds/wsMb on win). */
async function swTopProcesses() {
  try {
    if (PLATFORM === 'win32') {
      const res = await psQuery(
        'Get-Process | Sort-Object CPU -Descending | Select-Object -First 5 Name,CPU,WS | ConvertTo-Json -Compress',
        12000
      )
      if (!res.ok) return []
      let parsed
      try {
        parsed = JSON.parse(res.stdout || '')
      } catch {
        return []
      }
      const rows = Array.isArray(parsed) ? parsed : [parsed]
      return rows
        .filter((r) => r && typeof r.Name === 'string' && r.Name.length > 0)
        .slice(0, 5)
        .map((r) => ({
          name: r.Name.slice(0, 40),
          ...(Number.isFinite(r.CPU) ? { cpuSeconds: Math.round(r.CPU * 10) / 10 } : {}),
          ...(Number.isFinite(r.WS) ? { wsMb: Math.round(r.WS / 1048576) } : {}),
        }))
    }
    if (PLATFORM === 'darwin') {
      // BSD ps: -r sorts by current CPU usage
      const res = await runArgv('ps', ['-Ao', 'pcpu,comm', '-r'], 10000)
      if (!res.ok) return []
      const out = []
      for (const line of String(res.stdout || '').split(/\r?\n/).filter((l) => l.trim()).slice(1, 6)) {
        const m = /^\s*([\d.]+)\s+(.+)$/.exec(line)
        if (m && out.length < 5) {
          out.push({
            name: m[2].trim().split('/').pop().slice(0, 40),
            cpuPct: Math.round(parseFloat(m[1]) * 10) / 10,
          })
        }
      }
      return out
    }
    // linux
    const res = await runArgv('ps', ['aux', '--sort=-%cpu'], 10000)
    if (!res.ok) return []
    const out = []
    for (const line of String(res.stdout || '').split(/\r?\n/).filter((l) => l.trim()).slice(1, 6)) {
      const cols = line.trim().split(/\s+/)
      if (cols.length < 11 || out.length >= 5) continue
      const cpuPct = parseFloat(cols[2])
      const cmd = cols.slice(10).join(' ').split(/\s+/)[0]
      const name = cmd.split('/').pop() || cmd
      out.push({
        name: name.slice(0, 40),
        ...(Number.isFinite(cpuPct) ? { cpuPct: Math.round(cpuPct * 10) / 10 } : {}),
      })
    }
    return out
  } catch {
    return []
  }
}

let gpuCache = null // {value, at, hit} — shared by system_watch + voice_status

/** GPU names (shared probe). Cached 5min on success / 60s on miss. */
async function probeGpus() {
  const ttl = gpuCache && gpuCache.hit ? 300000 : 60000
  if (gpuCache && Date.now() - gpuCache.at < ttl) return gpuCache.value
  const gpus = await probeGpusOnce()
  gpuCache = { value: gpus, at: Date.now(), hit: gpus.length > 0 }
  return gpus
}

/** One real GPU scan. NOTE: Win32_VideoController's AdapterRAM is a uint32 —
 *  it caps at 4GB on real cards, so only the NAME is reported (honest data). */
async function probeGpusOnce() {
  try {
    if (PLATFORM === 'win32') {
      const res = await psQuery(
        'Get-CimInstance Win32_VideoController | ForEach-Object { Write-Output $_.Name }',
        10000
      )
      if (!res.ok) return []
      return String(res.stdout || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && l.length <= 120)
        .slice(0, 4)
    }
    if (PLATFORM === 'darwin') {
      const res = await runArgv('system_profiler', ['SPDisplaysDataType'], 10000)
      if (!res.ok) return []
      const out = []
      for (const line of String(res.stdout || '').split(/\r?\n/)) {
        const m = /Chipset Model:\s*(.+)$/.exec(line)
        if (m && out.length < 4) out.push(m[1].trim().slice(0, 120))
      }
      return out
    }
    // linux: lspci when present (containers/servers without X often lack it)
    const res = await runArgv('lspci', [], 8000)
    if (res.spawnError || !res.ok) return []
    const out = []
    for (const line of String(res.stdout || '').split(/\r?\n/)) {
      const m = /(?:VGA|3D|Display) compatible controller:\s*(.+)$/i.exec(line)
      if (m && out.length < 4) out.push(m[1].trim().slice(0, 120))
    }
    return out
  } catch {
    return []
  }
}

/** The full machine snapshot — the guardian's eyes. Every probe already
 *  degraded itself to null/[] on failure, so nothing here can throw. */
async function systemWatch() {
  const [cpuLoad, ram, disk, thermalC, battery, security, topProcesses, gpus] = await Promise.all([
    swCpuLoad(),
    swRam(),
    swDisk(),
    swThermal(),
    swBattery(),
    swSecurity(),
    swTopProcesses(),
    probeGpus(),
  ])
  return {
    ok: true,
    system: {
      cpu: { loadPct: cpuLoad, cores: os.cpus().length },
      ram,
      disk,
      thermalC,
      battery,
      security,
      topProcesses, // full top-5 by CPU — callers trim to taste
      gpus,
      uptimeHours: Math.round((os.uptime() / 3600) * 10) / 10,
      hostname: os.hostname(),
      platform: PLATFORM,
    },
  }
}

// ---------------- Windows UI automation (v3.2) ----------------
// Native Windows Settings (and other app-window) control through the .NET
// Framework System.Windows.Automation assemblies (UIAutomationClient +
// UIAutomationTypes) — built into every Windows install, ZERO dependencies.
// Sub-commands (args.command):
//   open_settings {page?}   → launch Settings on an allowlisted ms-settings: URI
//   inspect {window?,name?,depth?} → compact dump of the live control tree
//   find {window?,name}     → elements whose Name (or #AutomationId) matches
//   set_toggle {window?,name,state} → read + toggle + VERIFY a TogglePattern
//   click {window?,name}    → Invoke/Select on a matched element
// Windows-only; on other platforms every sub-command answers the structured
// {ok:false, error:'windows-only'} shape so callers can react gracefully.

/** ms-settings: deep-link allowlist (page key → uri). No free-form URIs. */
const SETTINGS_PAGES = {
  'network-status': 'ms-settings:network-status',
  'network-wifi': 'ms-settings:network-wifi',
  'network-ethernet': 'ms-settings:network-ethernet',
  bluetooth: 'ms-settings:bluetooth',
  display: 'ms-settings:display',
  apps: 'ms-settings:appsfeatures',
  accounts: 'ms-settings:yourinfo',
  privacy: 'ms-settings:privacy',
  update: 'ms-settings:windowsupdate',
  about: 'ms-settings:about',
}

/** Strict validator for window/name fragments that get embedded into
 *  PowerShell: letters, digits, space and . : _ # - ( ) ONLY — no quotes,
 *  backticks, $, semicolons, braces. Anything that could escape the
 *  single-quoted PS literals is rejected outright (escape by rejecting). */
const RE_UIA_TEXT = /^[A-Za-z0-9 .:_#\-()]{1,80}$/

/** Validate one window/name arg ('' when absent → caller applies defaults). */
function uiText(value, field) {
  const s = str(value)
  if (!s) return ''
  if (!RE_UIA_TEXT.test(s)) {
    throw new Error(`${field} may only contain letters, digits, spaces and . : _ # ( ) - (1-80 chars, no quotes)`)
  }
  return s
}

/** Embed a RE_UIA_TEXT-validated string as a single-quoted PS literal.
 *  The regex excludes single quotes, so no escaping is ever needed — any
 *  attempt to break out of the literal is rejected upstream in uiText. */
function psSingle(s) {
  return `'${s}'`
}

/** Shared UIA preamble: strict errors, the UIA assemblies, Find-Win (first
 *  top-level window whose Name CONTAINS the needle — -like is already
 *  case-insensitive in PowerShell), the window-found guard, walk stopwatch
 *  and the shared node counter. */
function psUiaPreamble(winNeedle) {
  return [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName UIAutomationClient',
    'Add-Type -AssemblyName UIAutomationTypes',
    'function Find-Win {',
    '  $root = [System.Windows.Automation.AutomationElement]::RootElement',
    '  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)',
    '  foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) {',
    `    if ($w.Current.Name -like ('*' + ${psSingle(winNeedle)} + '*')) { return $w }`,
    '  }',
    '  return $null',
    '}',
    '$target = Find-Win',
    "if (-not $target) { Write-Output 'WINDOW_NOT_FOUND'; exit 0 }",
    '$sw = [System.Diagnostics.Stopwatch]::StartNew()',
    '$script:seen = 0',
  ]
}

/**
 * Shared guarded depth-first tree-walk skeleton. Every fragment that varies
 * between inspect/find/set_toggle/click arrives PRE-VALIDATED: numbers are
 * bridge-generated integers, needles went through psSingle (which requires
 * uiText first), and state/match bodies are bridge-authored constants —
 * nothing user-supplied is ever spliced in raw. The walk is depth-, node-
 * and time-capped, so a huge tree can never hang the bridge.
 */
function psUiWalk(opts) {
  const stopParts = [`$script:seen -ge ${opts.nodeCap}`]
  if (opts.stopCond) stopParts.push(opts.stopCond)
  stopParts.push(`$sw.Elapsed.TotalSeconds -gt ${opts.timeCapS}`)
  const stop = stopParts.join(' -or ')
  return [
    ...psUiaPreamble(opts.win),
    ...opts.stateDecl,
    'function Walk {',
    '  param($el, $depth)',
    `  if ($depth -gt ${opts.depthCap}) { return }`,
    `  if (${stop}) { return }`,
    '  $kids = $el.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)',
    '  foreach ($k in $kids) {',
    `    if (${stop}) { return }`,
    '    $c = $k.Current',
    '    $script:seen++',
    "    $nm = ''",
    "    if ($c.Name) { $nm = ($c.Name -replace '[\\r\\n]+', ' ') }",
    `    if (${opts.matchCond}) {`,
    ...opts.matchBody.map((l) => '      ' + l),
    '    }',
    '    Walk $k ($depth + 1)',
    '  }',
    '}',
    'Walk $target 1',
    ...opts.postBlock,
  ].join('\n')
}

/** Stdout of a UIA script → trimmed non-empty lines. */
function uiStdoutLines(res) {
  return String(res.stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}

/** Map the WINDOW_NOT_FOUND marker (shared by every walk script). */
function uiWindowMissing() {
  return {
    ok: false,
    error: 'window-not-found',
    hint: 'that window is not open yet — run ui_automate open_settings first, then retry',
  }
}

/** Shared name / #AutomationId needle parsing for find + click. */
function uiNeedle(args) {
  const raw = uiText(args.name, 'name')
  if (!raw) throw new Error('name is required (the element name; prefix with # to target an AutomationId)')
  const byId = raw.startsWith('#')
  const needle = byId ? raw.slice(1) : raw
  if (!needle) throw new Error('name cannot be just #')
  return { needle, byId }
}

/** Match condition PS expression for a needle (Name contains, or AutomationId
 *  contains when the needle was given as #id). */
function uiMatchCond(needle, byId) {
  return byId
    ? `($c.AutomationId -and ($c.AutomationId -like ('*' + ${psSingle(needle)} + '*')))`
    : `($nm -like ('*' + ${psSingle(needle)} + '*'))`
}

async function uiOpenSettings(args) {
  const page = str(args.page) || 'network-status'
  const uri = SETTINGS_PAGES[page]
  if (!uri) {
    throw new Error(`unknown settings page: ${page} (use ${Object.keys(SETTINGS_PAGES).join(', ')})`)
  }
  // same fire-and-forget launch pattern as open_url — the URI is allowlist-built
  spawn('cmd', ['/c', 'start', '', uri], { detached: true, shell: false, stdio: 'ignore' }).unref()
  return {
    ok: true,
    opened: 'Settings',
    page,
    uri,
    note: 'give the window a moment to come up, then inspect to see its controls',
  }
}

async function uiInspect(args) {
  const win = uiText(args.window, 'window') || 'Settings'
  const filter = uiText(args.name, 'name')
  const depth = clampInt(args.depth, 4, 1, 8)
  const script = psUiWalk({
    win,
    depthCap: depth,
    nodeCap: 1500,
    timeCapS: 20,
    stopCond: '$script:out.Count -ge 120',
    stateDecl: ['$script:out = New-Object System.Collections.Generic.List[string]'],
    matchCond: '$true', // every element becomes one compact line
    matchBody: [
      "$tg = ''",
      'try { $p = $k.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern); if ($p) { $tg = [string]$p.Current.ToggleState } } catch {}',
      "$null = $script:out.Add(($depth.ToString() + '|' + $c.ControlType.ProgrammaticName.Replace('ControlType.', '') + '|' + $nm + '|' + $c.AutomationId + '|' + $c.ClassName + '|' + $tg))",
    ],
    postBlock: [
      "Write-Output ('WALKED|' + $script:seen.ToString() + '|' + $script:out.Count.ToString())",
      '$script:out',
    ],
  })
  const res = await psQuery(script, 30000)
  if (!res.ok) {
    return { ok: false, error: 'ui-inspect-failed', stderr: capOut(String(res.stderr || '').trim(), 400) }
  }
  const raw = uiStdoutLines(res)
  if (raw.length === 0) return { ok: false, error: 'ui-inspect-failed', stderr: 'no output from the UI walk' }
  if (raw[0] === 'WINDOW_NOT_FOUND') return uiWindowMissing()
  let walked = 0
  let lines = raw
  if (raw[0].startsWith('WALKED|')) {
    walked = Number.parseInt(raw[0].split('|')[1], 10) || 0
    lines = raw.slice(1)
  }
  if (filter) {
    const f = filter.toLowerCase()
    lines = lines.filter((l) => l.toLowerCase().includes(f))
  }
  return {
    ok: true,
    window: win,
    depth,
    count: lines.length,
    truncated: walked >= 1500 || lines.length >= 120,
    lines,
    ...(filter ? { filter } : {}),
  }
}

async function uiFind(args) {
  const win = uiText(args.window, 'window') || 'Settings'
  const target = uiNeedle(args)
  const script = psUiWalk({
    win,
    depthCap: 8,
    nodeCap: 1500,
    timeCapS: 20,
    stopCond: '$script:hits.Count -ge 40',
    stateDecl: ['$script:hits = New-Object System.Collections.Generic.List[string]'],
    matchCond: uiMatchCond(target.needle, target.byId),
    matchBody: [
      "$tg = ''",
      'try { $p = $k.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern); if ($p) { $tg = [string]$p.Current.ToggleState } } catch {}',
      "$ck = 'no'",
      "try { $pt = $k.GetClickablePoint(); $ck = ('yes(' + [int]$pt.X + ',' + [int]$pt.Y + ')') } catch {}",
      "$rect = 'empty'",
      "if (-not $c.BoundingRectangle.IsEmpty) { $rect = ([int]$c.BoundingRectangle.X.ToString() + ',' + [int]$c.BoundingRectangle.Y.ToString() + ',' + [int]$c.BoundingRectangle.Width.ToString() + ',' + [int]$c.BoundingRectangle.Height.ToString()) }",
      "$null = $script:hits.Add(($depth.ToString() + '|' + $c.ControlType.ProgrammaticName.Replace('ControlType.', '') + '|' + $nm + '|' + $c.AutomationId + '|' + $c.ClassName + '|' + $tg + '|' + $ck + '|' + $rect))",
    ],
    postBlock: [
      "Write-Output ('WALKED|' + $script:seen.ToString())",
      '$script:hits',
    ],
  })
  const res = await psQuery(script, 30000)
  if (!res.ok) {
    return { ok: false, error: 'ui-find-failed', stderr: capOut(String(res.stderr || '').trim(), 400) }
  }
  const raw = uiStdoutLines(res)
  if (raw.length === 0) return { ok: false, error: 'ui-find-failed', stderr: 'no output from the UI walk' }
  if (raw[0] === 'WINDOW_NOT_FOUND') return uiWindowMissing()
  let walked = 0
  let matches = raw
  if (raw[0].startsWith('WALKED|')) {
    walked = Number.parseInt(raw[0].split('|')[1], 10) || 0
    matches = raw.slice(1)
  }
  return {
    ok: true,
    window: win,
    needle: target.needle,
    search: target.byId ? 'automation-id' : 'name',
    count: matches.length,
    truncated: walked >= 1500 || matches.length >= 40,
    matches,
  }
}

async function uiSetToggle(args) {
  const win = uiText(args.window, 'window') || 'Settings'
  const name = uiText(args.name, 'name')
  if (!name) throw new Error("name is required (the toggle's element name, e.g. Metered connection)")
  const state = str(args.state).toLowerCase()
  if (state !== 'on' && state !== 'off') throw new Error("state must be 'on' or 'off'")
  const want = state === 'on' ? 'On' : 'Off' // ToggleState literal — validated above
  const script = psUiWalk({
    win,
    depthCap: 8,
    nodeCap: 2000,
    timeCapS: 22,
    stopCond: '[bool]$script:hit',
    stateDecl: ['$script:hit = $null'],
    matchCond: `($nm -like ('*' + ${psSingle(name)} + '*'))`,
    matchBody: [
      // only an element that actually supports TogglePattern counts as the hit
      'try { $p = $k.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern); if ($p) { $script:hit = $k; return } } catch {}',
    ],
    postBlock: [
      "if (-not $script:hit) { Write-Output 'NOT_FOUND'; exit 0 }",
      '$p = $script:hit.GetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern)',
      '$nm2 = $script:hit.Current.Name',
      "if ($nm2) { $nm2 = ($nm2 -replace '[\\r\\n]+', ' ') }",
      '$before = [string]$p.Current.ToggleState',
      `if ($before -ne ${psSingle(want)}) {`,
      '  $p.Toggle()',
      '  Start-Sleep -Milliseconds 400',
      '}',
      '$after = [string]$p.Current.ToggleState', // RE-READ — verified, not assumed
      "Write-Output ('RESULT|' + $nm2 + '|' + $before + '|' + $after)",
    ],
  })
  const res = await psQuery(script, 30000)
  if (!res.ok) {
    return { ok: false, error: 'ui-toggle-failed', stderr: capOut(String(res.stderr || '').trim(), 400) }
  }
  const raw = uiStdoutLines(res)
  if (raw.length === 0) return { ok: false, error: 'ui-toggle-failed', stderr: 'no output from the UI walk' }
  if (raw[0] === 'WINDOW_NOT_FOUND') return uiWindowMissing()
  if (raw[0] === 'NOT_FOUND') {
    return {
      ok: false,
      error: 'toggle-not-found',
      hint: 'run ui_automate inspect to see the tree and find the toggle element\u2019s exact name',
    }
  }
  const line = raw.find((l) => l.startsWith('RESULT|'))
  if (!line) return { ok: false, error: 'ui-toggle-failed', stderr: capOut(String(res.stderr || '').trim(), 300) }
  const parts = line.split('|')
  const after = parts[parts.length - 1].toLowerCase()
  const before = parts[parts.length - 2].toLowerCase()
  const elemName = parts.slice(1, -2).join('|')
  if (after !== state) {
    return {
      ok: false,
      error: 'toggle-verify-failed',
      name: elemName,
      before,
      after,
      hint: 'the toggle did not hold the requested state — it may be disabled or controlled by policy',
    }
  }
  return { ok: true, name: elemName, before, after, changed: before !== after }
}

async function uiClick(args) {
  const win = uiText(args.window, 'window') || 'Settings'
  const target = uiNeedle(args)
  const script = psUiWalk({
    win,
    depthCap: 8,
    nodeCap: 2000,
    timeCapS: 22,
    stopCond: '[bool]$script:hit',
    stateDecl: ['$script:hit = $null'],
    matchCond: uiMatchCond(target.needle, target.byId),
    matchBody: ['$script:hit = $k', 'return'],
    postBlock: [
      "if (-not $script:hit) { Write-Output 'NOT_FOUND'; exit 0 }",
      '$nm2 = $script:hit.Current.Name',
      "if ($nm2) { $nm2 = ($nm2 -replace '[\\r\\n]+', ' ') }",
      'try {',
      '  $ip = $script:hit.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)',
      '  $ip.Invoke()',
      "  Write-Output ('CLICKED|invoke|' + $nm2)",
      '  exit 0',
      '} catch {}',
      'try {',
      '  $sp = $script:hit.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)',
      '  $sp.Select()',
      "  Write-Output ('CLICKED|select|' + $nm2)",
      '  exit 0',
      '} catch {}',
      "Write-Output ('NOT_CLICKABLE|' + $nm2)",
    ],
  })
  const res = await psQuery(script, 30000)
  if (!res.ok) {
    return { ok: false, error: 'ui-click-failed', stderr: capOut(String(res.stderr || '').trim(), 400) }
  }
  const raw = uiStdoutLines(res)
  if (raw.length === 0) return { ok: false, error: 'ui-click-failed', stderr: 'no output from the UI walk' }
  if (raw[0] === 'WINDOW_NOT_FOUND') return uiWindowMissing()
  if (raw[0] === 'NOT_FOUND') {
    return {
      ok: false,
      error: 'element-not-found',
      hint: 'run ui_automate inspect to see the tree and find the element\u2019s exact name',
    }
  }
  const clicked = raw.find((l) => l.startsWith('CLICKED|'))
  if (clicked) {
    const parts = clicked.split('|')
    return { ok: true, clicked: parts.slice(2).join('|'), via: parts[1] }
  }
  if (raw[0].startsWith('NOT_CLICKABLE|')) {
    return {
      ok: false,
      error: 'not-clickable',
      element: raw[0].slice('NOT_CLICKABLE|'.length),
      hint: 'the element supports neither Invoke nor Selection — try set_toggle for switches or inspect for neighbors',
    }
  }
  return { ok: false, error: 'ui-click-failed', stderr: capOut(String(res.stderr || '').trim(), 300) }
}

/** The ui_automate action — Windows-native UI control. */
async function uiAutomate(args) {
  const command = str(args.command).toLowerCase()
  if (PLATFORM !== 'win32') {
    return {
      ok: false,
      error: 'windows-only',
      hint: 'ui_automate works on the Windows bridge — it drives native Windows apps (Settings, metered connection, …) through UI Automation; this machine is not Windows',
    }
  }
  switch (command) {
    case 'open_settings':
      return uiOpenSettings(args)
    case 'inspect':
      return uiInspect(args)
    case 'find':
      return uiFind(args)
    case 'set_toggle':
      return uiSetToggle(args)
    case 'click':
      return uiClick(args)
    default:
      throw new Error(
        `unknown command: ${command || '(missing)'} (use open_settings|inspect|find|set_toggle|click)`
      )
  }
}

// ---------------- actions ----------------

/** Every /exec action. Each returns a JSON-safe object; errors bubble to the wrapper. */
const ACTIONS = {
  status() {
    return { ok: true, version: VERSION, platform: PLATFORM, hostname: os.hostname() }
  },

  system_info() {
    let username = null
    try {
      username = os.userInfo().username
    } catch {
      username = null
    }
    const cpus = os.cpus()
    return {
      ok: true,
      platform: PLATFORM,
      release: os.release(),
      arch: os.arch(),
      hostname: os.hostname(),
      cpu_model: cpus.length > 0 ? cpus[0].model : 'unknown',
      cpu_count: cpus.length,
      total_mem_gb: Math.round((os.totalmem() / 1024 ** 3) * 100) / 100,
      free_mem_gb: Math.round((os.freemem() / 1024 ** 3) * 100) / 100,
      uptime_s: Math.round(os.uptime()),
      username,
      loadavg: PLATFORM === 'win32' ? [0, 0, 0] : os.loadavg().map((v) => Math.round(v * 100) / 100),
    }
  },

  list_apps() {
    const apps = listApps()
      .slice(0, MAX_APPS_RETURN)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((app) => ({ name: app.name, path: app.path, kind: app.kind }))
    return { ok: true, count: apps.length, apps }
  },

  open_app(args) {
    const name = str(args.name)
    if (!name) throw new Error('name is required')
    const apps = listApps()
    const match = pickApp(apps, name)
    if (!match) {
      return { ok: false, error: 'not found', suggestion: suggestApps(apps, name) }
    }
    launchApp(match)
    return { ok: true, opened: match.name, path: match.path }
  },

  open_url(args) {
    const url = str(args.url)
    if (!/^https?:\/\//i.test(url)) throw new Error('url must start with http:// or https://')
    if (PLATFORM === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, shell: false, stdio: 'ignore' }).unref()
    } else if (PLATFORM === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
    }
    return { ok: true, opened: url, browser: 'default' }
  },

  run_command(args) {
    const command = str(args.command)
    if (!command) throw new Error('command is required')
    const cwd = args.cwd !== undefined && args.cwd !== null ? jailPath(args.cwd) : HOME
    const timeoutMs = clampInt(args.timeoutMs, DEFAULT_CMD_TIMEOUT, 1000, MAX_CMD_TIMEOUT)
    return new Promise((resolve) => {
      exec(
        command,
        { cwd, timeout: timeoutMs, maxBuffer: 2 * MAX_FILE_BYTES, windowsHide: true },
        (err, stdout, stderr) => {
          const out = typeof stdout === 'string' ? stdout : ''
          const se = typeof stderr === 'string' ? stderr : ''
          const errText = err && err.message ? err.message : ''
          resolve({
            ok: !err,
            stdout: capOut(out, MAX_CMD_OUTPUT),
            stderr: capOut(se.length > 0 ? se : errText, MAX_CMD_OUTPUT),
            code: err ? (typeof err.code === 'number' ? err.code : null) : 0,
          })
        }
      )
    })
  },

  list_dir(args) {
    const raw = args.path === undefined || args.path === null ? '.' : args.path
    const dir = jailPath(raw)
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch (err) {
      throw new Error(`cannot list ${dir}: ${err instanceof Error ? err.message : String(err)}`)
    }
    const out = []
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= MAX_DIR_ENTRIES) break
      if (entry.name.startsWith('.')) continue // hide dotfiles
      const item = { name: entry.name, kind: entry.isDirectory() ? 'dir' : 'file' }
      if (!entry.isDirectory()) {
        try {
          item.size = fs.statSync(path.join(dir, entry.name)).size
        } catch {
          /* size is optional */
        }
      }
      out.push(item)
    }
    return { ok: true, path: dir, entries: out, truncated: out.length >= MAX_DIR_ENTRIES }
  },

  read_file(args) {
    const file = jailPath(args.path)
    let stat
    try {
      stat = fs.statSync(file)
    } catch {
      throw new Error(`file not found: ${file}`)
    }
    if (!stat.isFile()) throw new Error('not a file')
    if (stat.size > MAX_FILE_BYTES) throw new Error('file exceeds the 1MB limit')
    const content = fs.readFileSync(file, 'utf-8')
    return { ok: true, path: file, bytes: Buffer.byteLength(content, 'utf-8'), content }
  },

  write_file(args) {
    const file = jailPath(args.path)
    guardSelfModification(file)
    const content = typeof args.content === 'string' ? args.content : ''
    if (Buffer.byteLength(content, 'utf-8') > MAX_FILE_BYTES) {
      throw new Error('content exceeds the 1MB limit')
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content, 'utf-8')
    return { ok: true, path: file, bytes: Buffer.byteLength(content, 'utf-8') }
  },

  // ===== v3.3: full file operations (the "operate my system" quartet) =====
  move_file(args) {
    const from = jailPath(args.from)
    const to = jailPath(args.to)
    guardSelfModification(from)
    guardSelfModification(to)
    const overwrite = args.overwrite === true
    if (from === to) throw new Error('source and destination are the same path')
    let stat
    try {
      stat = fs.statSync(from)
    } catch {
      throw new Error(`source not found: ${from}`)
    }
    if (!overwrite && fs.existsSync(to)) throw new Error(`destination exists (pass overwrite:true): ${to}`)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    try {
      fs.renameSync(from, to)
    } catch {
      // rename can fail across drives — fall back to copy+delete
      if (stat.isFile()) fs.copyFileSync(from, to)
      else fs.cpSync(from, to, { recursive: true })
      fs.rmSync(from, { recursive: true, force: true })
    }
    return { ok: true, moved: from, to, kind: stat.isDirectory() ? 'dir' : 'file' }
  },

  copy_file(args) {
    const from = jailPath(args.from)
    const to = jailPath(args.to)
    guardSelfModification(to)
    const overwrite = args.overwrite === true
    let stat
    try {
      stat = fs.statSync(from)
    } catch {
      throw new Error(`source not found: ${from}`)
    }
    if (stat.isFile() && stat.size > MAX_FILE_BYTES) throw new Error('file exceeds the 1MB copy limit')
    if (!overwrite && fs.existsSync(to)) throw new Error(`destination exists (pass overwrite:true): ${to}`)
    fs.mkdirSync(path.dirname(to), { recursive: true })
    if (stat.isFile()) fs.copyFileSync(from, to)
    else fs.cpSync(from, to, { recursive: true })
    return { ok: true, copied: from, to, kind: stat.isDirectory() ? 'dir' : 'file' }
  },

  delete_file(args) {
    const target = jailPath(args.path)
    guardSelfModification(target)
    let stat
    try {
      stat = fs.statSync(target)
    } catch {
      throw new Error(`not found: ${target}`)
    }
    if (stat.isDirectory()) {
      // recursive directory deletion must be requested explicitly — never accidental
      if (args.recursive === true) fs.rmSync(target, { recursive: true, force: true })
      else fs.rmdirSync(target)
      return { ok: true, deleted: target, kind: 'dir', recursive: args.recursive === true }
    }
    fs.rmSync(target, { force: true })
    return { ok: true, deleted: target, kind: 'file' }
  },

  make_dir(args) {
    const dir = jailPath(args.path)
    guardSelfModification(dir)
    fs.mkdirSync(dir, { recursive: true })
    return { ok: true, dir }
  },

  // ===== v3.4: mission-grade file intelligence (stat / search / zip / unzip) =====

  /** stat_path — one path → size, kind, created/modified dates (the date-based
   *  filtering primitive missions need: "images from this week"). */
  stat_path(args) {
    const target = jailPath(args.path)
    let stat
    try {
      stat = fs.statSync(target)
    } catch {
      throw new Error(`not found: ${target}`)
    }
    return {
      ok: true,
      path: target,
      name: path.basename(target),
      kind: stat.isDirectory() ? 'dir' : 'file',
      size: stat.size,
      size_kb: Math.round(stat.size / 102.4) / 10,
      ext: stat.isFile() ? path.extname(target).replace('.', '').toLowerCase() : '',
      created: stat.birthtime.toISOString(),
      modified: stat.mtime.toISOString(),
    }
  },

  /** search_files — recursive glob search under a jailed folder with optional
   *  extension / modified-within-days / min-size filters. Depth-capped walk,
   * unreadable subtrees skipped, newest-first results. */
  search_files(args) {
    const root = jailPath(args.path === undefined || args.path === null ? '.' : args.path)
    let rootStat
    try {
      rootStat = fs.statSync(root)
    } catch {
      throw new Error(`folder not found: ${root}`)
    }
    if (!rootStat.isDirectory()) throw new Error(`not a folder: ${root}`)
    const pattern = str(args.pattern) || '*'
    const exts = str(args.ext)
      ? str(args.ext)
          .split(',')
          .map((e) => e.trim().toLowerCase().replace(/^\./, ''))
          .filter(Boolean)
      : []
    const withinDaysRaw = Number(args.modifiedWithinDays)
    const withinDays = Number.isFinite(withinDaysRaw) && withinDaysRaw > 0 ? withinDaysRaw : null
    const minSizeKbRaw = Number(args.minSizeKb)
    const minSizeKb = Number.isFinite(minSizeKbRaw) && minSizeKbRaw > 0 ? minSizeKbRaw : null
    const limit = clampInt(args.limit, 200, 1, 1000)
    const regex = globToRegex(pattern)
    const cutoff = withinDays ? Date.now() - withinDays * 86400000 : null
    const matches = []
    let scanned = 0
    const walk = (dir, depth) => {
      if (matches.length >= limit || depth > 6) return // depth cap: home trees nest deep
      let entries
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        return // unreadable subtree — skip it, never fail the whole search
      }
      for (const entry of entries) {
        if (matches.length >= limit) return
        if (entry.name.startsWith('.')) continue
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          walk(full, depth + 1)
        } else {
          scanned++
          if (!regex.test(entry.name)) continue
          const ext = path.extname(entry.name).replace('.', '').toLowerCase()
          if (exts.length > 0 && !exts.includes(ext)) continue
          let st
          try {
            st = fs.statSync(full)
          } catch {
            continue
          }
          if (cutoff && st.mtimeMs < cutoff) continue
          if (minSizeKb && st.size < minSizeKb * 1024) continue
          matches.push({
            path: path.relative(HOME, full),
            name: entry.name,
            ext,
            size_kb: Math.round(st.size / 102.4) / 10,
            modified: st.mtime.toISOString(),
          })
        }
      }
    }
    walk(root, 0)
    return {
      ok: true,
      root: path.relative(HOME, root) || '.',
      pattern,
      filters: { exts, within_days: withinDays, min_size_kb: minSizeKb },
      scanned,
      count: matches.length,
      truncated: matches.length >= limit,
      matches: matches.sort((a, b) => b.modified.localeCompare(a.modified)),
    }
  },

  /** zip_files — compress a file or folder. Windows: PowerShell
   *  Compress-Archive (built in). Others: `zip -r` when available, else
   *  tar.gz (reported honestly — the archive extension tells the truth). */
  async zip_files(args) {
    const from = jailPath(args.from)
    const to = jailPath(args.to)
    guardSelfModification(to)
    const wantsTar = /\.(tar\.gz|tgz)$/i.test(to)
    const wantsZip = /\.zip$/i.test(to)
    if (!wantsZip && !wantsTar) {
      throw new Error('destination must end in .zip (Windows) or .tar.gz (Linux/macOS)')
    }
    let stat
    try {
      stat = fs.statSync(from)
    } catch {
      throw new Error(`source not found: ${from}`)
    }
    if (fs.existsSync(to) && args.overwrite !== true) {
      throw new Error(`destination exists (pass overwrite:true): ${to}`)
    }
    fs.mkdirSync(path.dirname(to), { recursive: true })

    const runShell = (command) =>
      new Promise((resolve) => {
        exec(command, { cwd: HOME, timeout: 110000, maxBuffer: 2 * MAX_FILE_BYTES, windowsHide: true }, (err, stdout, stderr) => {
          resolve({ ok: !err, stdout: capOut(String(stdout || ''), 800), stderr: capOut(String(stderr || (err && err.message) || ''), 800) })
        })
      })

    let res
    let archivePath = to
    if (PLATFORM === 'win32') {
      if (!wantsZip) throw new Error('on Windows the destination must end in .zip')
      const q = (s) => `'${String(s).replaceAll("'", "''")}'`
      res = await runShell(
        `powershell -NoProfile -Command "Compress-Archive -Path ${q(from)} -DestinationPath ${q(to)}${args.overwrite === true ? ' -Force' : ''}"`
      )
    } else if (wantsTar) {
      res = await runShell(`tar -czf ${shellQuote(to)} -C ${shellQuote(path.dirname(from))} ${shellQuote(path.basename(from))}`)
    } else {
      // .zip requested on Linux/macOS — zip binary, tar.gz fallback
      const probe = await runShell('command -v zip')
      if (probe.ok && probe.stdout.trim()) {
        res = await runShell(`zip -r -q ${shellQuote(to)} ${shellQuote(from)}`)
      } else {
        archivePath = to.replace(/\.zip$/i, '.tar.gz')
        if (fs.existsSync(archivePath)) fs.rmSync(archivePath, { force: true })
        res = await runShell(`tar -czf ${shellQuote(archivePath)} -C ${shellQuote(path.dirname(from))} ${shellQuote(path.basename(from))}`)
        if (res.ok) {
          return {
            ok: true,
            archive: archivePath,
            format: 'tar.gz',
            note: 'the zip utility is not installed on this machine — I created a tar.gz archive instead (same content, standard format)',
          }
        }
      }
    }
    if (!res.ok) throw new Error(`compression failed: ${res.stderr || res.stdout || 'unknown error'}`)
    const size = fs.existsSync(archivePath) ? fs.statSync(archivePath).size : 0
    return { ok: true, archive: archivePath, format: wantsTar && PLATFORM !== 'win32' ? 'tar.gz' : 'zip', bytes: size, size_kb: Math.round(size / 102.4) / 10 }
  },

  /** unzip_file — extract a .zip (Windows: Expand-Archive; others: unzip or
   *  python3 -m zipfile) or .tar.gz (tar -xzf). Destination folder is created. */
  async unzip_file(args) {
    const from = jailPath(args.from)
    const to = jailPath(args.to)
    guardSelfModification(to)
    let stat
    try {
      stat = fs.statSync(from)
    } catch {
      throw new Error(`archive not found: ${from}`)
    }
    if (!stat.isFile()) throw new Error('source is not a file')
    const isTar = /\.(tar\.gz|tgz)$/i.test(from)
    const isZip = /\.zip$/i.test(from)
    if (!isZip && !isTar) throw new Error('archive must end in .zip or .tar.gz')
    fs.mkdirSync(to, { recursive: true })

    const runShell = (command) =>
      new Promise((resolve) => {
        exec(command, { cwd: HOME, timeout: 110000, maxBuffer: 2 * MAX_FILE_BYTES, windowsHide: true }, (err, stdout, stderr) => {
          resolve({ ok: !err, stdout: capOut(String(stdout || ''), 800), stderr: capOut(String(stderr || (err && err.message) || ''), 800) })
        })
      })

    let res
    if (PLATFORM === 'win32') {
      if (!isZip) throw new Error('on Windows the archive must be a .zip (Expand-Archive)')
      const q = (s) => `'${String(s).replaceAll("'", "''")}'`
      res = await runShell(`powershell -NoProfile -Command "Expand-Archive -Path ${q(from)} -DestinationPath ${q(to)} -Force"`)
    } else if (isTar) {
      res = await runShell(`tar -xzf ${shellQuote(from)} -C ${shellQuote(to)}`)
    } else {
      const probe = await runShell('command -v unzip')
      if (probe.ok && probe.stdout.trim()) {
        res = await runShell(`unzip -o -q ${shellQuote(from)} -d ${shellQuote(to)}`)
      } else {
        res = await runShell(`python3 -m zipfile -e ${shellQuote(from)} ${shellQuote(to)}`)
      }
    }
    if (!res.ok) throw new Error(`extraction failed: ${res.stderr || res.stdout || 'unknown error'}`)
    return { ok: true, extracted_to: to, archive: from }
  },

  // ===== v2: companions + hermes + signal bus =====
  companions() {
    return companions()
  },
  hermes_status() {
    return hermesStatus()
  },
  hermes_ask(args) {
    return hermesAsk(args)
  },
  hermes_sessions(args) {
    return hermesSessions(args)
  },
  hermes_memory(args) {
    return hermesMemory(args)
  },
  hermes_skills(args) {
    return hermesSkills(args)
  },
  hermes_cron(args) {
    return hermesCron(args)
  },
  signal_setup(args) {
    return signalSetup(args)
  },
  signal_emit(args) {
    return signalEmit(args)
  },
  signal_status() {
    return signalStatus()
  },
  // ===== v3: local offline voice (whisper.cpp STT + piper TTS) =====
  voice_status() {
    return voiceStatus()
  },
  voice_setup(args) {
    return voiceSetup(args)
  },
  voice_stt(args) {
    return voiceStt(args)
  },
  voice_tts(args) {
    return voiceTts(args)
  },
  // v3.6 — engine reuse + voice selection (find faster-whisper / piper that
  // already exist on this machine — e.g. Hermes installs — and adopt them)
  voice_discover() {
    return voiceDiscover()
  },
  voice_adopt(args) {
    return voiceAdopt(args)
  },
  voice_voices() {
    return voiceVoices()
  },
  voice_select(args) {
    return voiceSelect(args)
  },
  // ===== v3.1: system watch (the proactive machine guardian) =====
  system_watch() {
    return systemWatch()
  },
  // ===== v3.2: Windows UI automation (Settings, metered connection, …) =====
  ui_automate(args) {
    return uiAutomate(args)
  },
}

// ---------------- MCP stdio server (--mcp) ----------------

/** POST JSON to the local M.I.S.T. app and return the parsed body. */
function appPost(pathname, body, timeoutMs) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(body)
    const req = http.request(
      {
        host: '127.0.0.1',
        port: Number.parseInt(process.env.MIST_APP_PORT || '3000', 10) || 3000,
        path: pathname,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        timeout: timeoutMs || 60000,
      },
      (res) => {
        let data = ''
        res.on('data', (d) => {
          if (data.length < 500000) data += String(d)
        })
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) })
          } catch {
            resolve({ status: res.statusCode, body: null, raw: data.slice(0, 2000) })
          }
        })
      }
    )
    req.on('timeout', () => {
      req.destroy()
      resolve({ status: 0, body: null, error: 'timeout' })
    })
    req.on('error', (err) => resolve({ status: 0, body: null, error: String(err.message || err) }))
    req.end(payload)
  })
}

/** GET JSON from the local M.I.S.T. app. */
function appGet(pathname, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: Number.parseInt(process.env.MIST_APP_PORT || '3000', 10) || 3000,
        path: pathname,
        method: 'GET',
        headers: { Accept: 'application/json' },
        timeout: timeoutMs || 8000,
      },
      (res) => {
        let data = ''
        res.on('data', (d) => {
          if (data.length < 500000) data += String(d)
        })
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) })
          } catch {
            resolve({ status: res.statusCode, body: null, raw: data.slice(0, 2000) })
          }
        })
      }
    )
    req.on('timeout', () => {
      req.destroy()
      resolve({ status: 0, body: null, error: 'timeout' })
    })
    req.on('error', (err) => resolve({ status: 0, body: null, error: String(err.message || err) }))
    req.end()
  })
}

const MCP_TOOLS = [
  {
    name: 'mist_status',
    description:
      'Health of the local M.I.S.T. app (her web UI runs on this machine) — version, services, uptime. Use this first to check she is running.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'mist_ask',
    description:
      'Ask M.I.S.T. (the local web AI assistant) a question. She answers with her own brain, memory and tools — a full agent turn, not a raw model call.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The question or task for Mist' },
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
  {
    name: 'mist_memory_search',
    description:
      'Semantic search over M.I.S.T.\u2019s long-term vector memory — facts she has learned about her owner, past conversations, skills and notes.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for in Mist\u2019s memory' },
        n: { type: 'number', description: 'Max results (1-25, default 5)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'mist_signal',
    description:
      'Drive the M.I.S.T. signal bus: set her visual state (idle|listening|thinking|speaking) so every ai-visualizer face on this machine performs it. Optionally raise/clear an alert (all faces turn red).',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['idle', 'listening', 'thinking', 'speaking'] },
        alert: { type: 'boolean', description: 'true raises a red alert on all faces, false clears it' },
      },
      additionalProperties: false,
    },
  },
]

async function mcpCallTool(name, args) {
  if (name === 'mist_status') {
    const res = await appGet('/api/mist/health', 6000)
    if (res.status !== 200) {
      return `M.I.S.T. app is not reachable on this machine (status ${res.status}). She runs with 'bun run dev' / run.bat in her project folder.`
    }
    return JSON.stringify(res.body)
  }
  if (name === 'mist_ask') {
    const message = typeof args.message === 'string' ? args.message : ''
    if (!message.trim()) return 'error: message is required'
    const res = await appPost('/api/mist/llm/unified', { message }, 120000)
    if (res.status !== 200 || !res.body) {
      return `error: Mist's app answered status ${res.status}${res.error ? ` (${res.error})` : ''} — is she running?`
    }
    const body = res.body
    return `${body.text || ''}\n\n— ${body.provider || 'mist'}${body.model ? ` · ${body.model}` : ''}`
  }
  if (name === 'mist_memory_search') {
    const query = typeof args.query === 'string' ? args.query : ''
    if (!query.trim()) return 'error: query is required'
    const n = Math.max(1, Math.min(25, Number(args.n) || 5))
    const res = await appPost('/api/mist/memory/vector/search', { query, n_results: n }, 20000)
    if (res.status !== 200 || !res.body) return `error: memory search failed (status ${res.status})`
    return JSON.stringify(res.body)
  }
  if (name === 'mist_signal') {
    const out = await signalEmit(args)
    return JSON.stringify(out)
  }
  return `error: unknown tool ${name}`
}

/** Minimal MCP stdio server (newline-delimited JSON-RPC 2.0). */
function runMcpServer() {
  const log = (line) => process.stderr.write(`[mist-mcp] ${line}\n`)
  log(`M.I.S.T. MCP server up (bridge v${VERSION}, pid ${process.pid})`)
  let buffer = ''
  let inFlight = 0
  let stdinClosed = false
  process.stdin.setEncoding('utf-8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue // not JSON — ignore, never crash the pipe
      }
      inFlight++
      handleMcpMessage(msg)
        .catch((err) =>
          log(`handler error: ${err instanceof Error ? err.message : String(err)}`)
        )
        .finally(() => {
          inFlight--
        })
    }
  })
  process.stdin.on('end', () => {
    stdinClosed = true
    log('stdin closed — draining in-flight calls')
    // give in-flight tool calls a moment to finish before exiting
    const started = Date.now()
    const check = () => {
      if (inFlight <= 0 || Date.now() - started > 3000) process.exit(0)
      else setTimeout(check, 100)
    }
    check()
  })
  // guard: never let a stray error kill the pipe silently
  process.on('uncaughtException', (err) => {
    log(`uncaught: ${err instanceof Error ? err.stack || err.message : String(err)}`)
    if (stdinClosed) process.exit(1)
  })

  async function handleMcpMessage(msg) {
    const { id, method, params } = msg
    const isNotification = id === undefined || id === null
    try {
      if (method === 'initialize') {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: (params && params.protocolVersion) || '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'mist-bridge', version: VERSION },
          },
        })
        return
      }
      if (method === 'notifications/initialized' || isNotification) return
      if (method === 'ping') {
        send({ jsonrpc: '2.0', id, result: {} })
        return
      }
      if (method === 'tools/list') {
        send({ jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } })
        return
      }
      if (method === 'tools/call') {
        const name = params && params.name
        const args = (params && params.arguments) || {}
        try {
          const text = await mcpCallTool(name, args)
          send({
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: String(text) }] },
          })
        } catch (err) {
          send({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: `error: ${err instanceof Error ? err.message : String(err)}` }],
              isError: true,
            },
          })
        }
        return
      }
      if (method === 'resources/list' || method === 'prompts/list') {
        send({ jsonrpc: '2.0', id, result: method === 'resources/list' ? { resources: [] } : { prompts: [] } })
        return
      }
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } })
    } catch (err) {
      if (!isNotification) {
        send({
          jsonrpc: '2.0',
          id,
          error: { code: -32603, message: err instanceof Error ? err.message : 'internal error' },
        })
      }
    }
  }

  function send(obj) {
    process.stdout.write(`${JSON.stringify(obj)}\n`)
  }
}

// ---------------- HTTP plumbing ----------------

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Read the request body; invalid JSON → 400. The cap stays 1MB for every
 * action except voice_stt (a base64 WAV) — the action is sniffed from the
 * head of the stream, which is safe because the app's proxy always sends
 * {"action":"voice_stt",...} with the action key first.
 */
const RE_VOICE_STT_ACTION = /"\s*action\s*"\s*:\s*"voice_stt\s*"/
function readBody(req, res, cb) {
  const chunks = []
  let size = 0
  let head = ''
  let aborted = false
  req.on('data', (chunk) => {
    if (aborted) return
    size += chunk.length
    if (head.length < 8192) head += chunk.toString('latin1')
    const cap = RE_VOICE_STT_ACTION.test(head) ? MAX_VOICE_BODY_BYTES : MAX_BODY_BYTES
    if (size > cap) {
      aborted = true
      sendJson(res, 413, {
        ok: false,
        error: `request body exceeds ${Math.round(cap / (1024 * 1024))}MB`,
      })
      req.destroy()
      return
    }
    chunks.push(chunk)
  })
  req.on('end', () => {
    if (aborted) return
    let body = {}
    try {
      body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : {}
    } catch {
      sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
      return
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      sendJson(res, 400, { ok: false, error: 'body must be a JSON object' })
      return
    }
    cb(body)
  })
  req.on('error', () => {
    if (!aborted) sendJson(res, 400, { ok: false, error: 'request failed' })
  })
}

function handleExec(req, res) {
  readBody(req, res, (body) => {
    const action = typeof body.action === 'string' ? body.action : ''
    const args =
      body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : {}
    const handler = ACTIONS[action]
    if (!handler) {
      sendJson(res, 400, {
        ok: false,
        error: `unknown action: ${action || '(missing)'}`,
        available: Object.keys(ACTIONS),
      })
      return
    }
    Promise.resolve()
      .then(() => handler(args))
      .then((result) => sendJson(res, 200, result))
      .catch((err) =>
        sendJson(res, 200, {
          ok: false,
          error: err instanceof Error ? err.message : 'action failed',
        })
      )
  })
}

function startHttpServer() {
  const server = http.createServer((req, res) => {
    setCors(res)
    if (req.method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }
    let url
    try {
      url = new URL(req.url || '/', `http://${HOST}:${PORT}`)
    } catch {
      sendJson(res, 400, { ok: false, error: 'bad request path' })
      return
    }
    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, { ok: true, version: VERSION, platform: PLATFORM, hostname: os.hostname() })
      return
    }
    if (req.method === 'POST' && url.pathname === '/exec') {
      handleExec(req, res)
      return
    }
    sendJson(res, 404, { ok: false, error: 'not found (GET /health, POST /exec)' })
  })

  server.listen(PORT, HOST, () => {
    const lines = [
      '',
      '  ╔══════════════════════════════════════════╗',
      '  ║         M I S T   B R I D G E   v3        ║',
      '  ╚══════════════════════════════════════════╝',
      '',
      `  version   : ${VERSION}`,
      `  listening : http://${HOST}:${PORT}   (this machine only)`,
      `  platform  : ${PLATFORM} (${os.arch()}) — ${os.hostname()}`,
      `  home jail : ${HOME}`,
      '',
      '  Keep this window open. Mist connects automatically.',
      '  Press Ctrl+C to stop.',
      '',
    ]
    console.log(lines.join('\n'))
  })

  server.on('error', (err) => {
    console.error(`[mist-bridge] could not start: ${err instanceof Error ? err.message : String(err)}`)
    console.error('[mist-bridge] is another mist-bridge.js already running on this port?')
    process.exit(1)
  })
}

// ---------------- entry ----------------

if (process.argv.includes('--mcp')) {
  runMcpServer()
} else {
  startHttpServer()
}
