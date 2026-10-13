// M.I.S.T. secret scanner — Phase 1 · S9 (commit 6).
//
// The last line of defense against secrets entering git: the pre-commit hook
// (hooks/pre-commit → `exec bun scripts/secret-scan.ts`) runs this over every
// STAGED text file and aborts the commit on the first finding. History that
// already contains secrets is an owner decision (rewrite backlogged — see
// phase0-report §9.10); this scanner only guards the future.
//
// A third surface: --dir=<path> scans a whole directory tree (skipping .git/
// and node_modules/) — used by the GitHub mirror sync gate (github-service.ts)
// because the EXPORT repo has no pre-commit hook; the gate lives in the sync
// itself and fails closed.
//
// Patterns (the Phase 1 register — extend as providers are added):
//   sk-…        OpenAI/Anthropic-style API keys
//   ghp_…       GitHub personal access tokens (classic + fine-grained)
//   github_pat_…
//   nvapi-…     NVIDIA builds API keys
//   xai-…       xAI keys
//   AIza…       Google API keys
//   KEY=…       credential-shaped assignments (KEY/TOKEN/SECRET/PASSWORD =
//               a 20+ char value) — catches .env dumps and config blobs
//
// Suppression: --allow=<substring> (repeatable) drops findings whose matched
// value CONTAINS the entry — for known-safe fixtures, never for laziness.
// Usage:  bun scripts/secret-scan.ts [--allow=substring]…   (no args: staged set)
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { spawnSync } from 'node:child_process'

export interface SecretFinding {
  line: number
  kind: string
  /** The matched secret substring (never printed in full by the CLI). */
  match: string
}

interface Pattern {
  kind: string
  re: RegExp
}

const PATTERNS: Pattern[] = [
  { kind: 'sk- key (OpenAI/Anthropic-style)', re: /sk-[A-Za-z0-9_-]{16,}/g },
  { kind: 'ghp_ GitHub token', re: /ghp_[A-Za-z0-9]{20,}/g },
  { kind: 'github_pat_ GitHub fine-grained token', re: /github_pat_[A-Za-z0-9_]{20,}/g },
  { kind: 'nvapi- NVIDIA key', re: /nvapi-[A-Za-z0-9-]{20,}/g },
  { kind: 'xai- xAI key', re: /xai-[A-Za-z0-9]{16,}/g },
  { kind: 'AIza Google API key', re: /AIza[0-9A-Za-z_-]{20,}/g },
  {
    kind: 'credential assignment (KEY/TOKEN/SECRET/PASSWORD=…)',
    re: /\b[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*\s*[:=]\s*["']?[A-Za-z0-9_+/=.=-]{20,}/g,
  },
]

/** Scan one text blob. allowlist entries suppress findings whose matched
 * value contains the entry (substring semantics — allow the fixture, not
 * the whole line). */
export function scanText(text: string, allowlist: string[] = []): SecretFinding[] {
  const findings: SecretFinding[] = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    for (const { kind, re } of PATTERNS) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(line)) !== null) {
        const match = m[0]
        if (allowlist.some((a) => a.length > 0 && match.includes(a))) continue
        findings.push({ line: i + 1, kind, match })
      }
    }
  }
  return findings
}

function redact(secret: string): string {
  return `${secret.slice(0, 6)}…(${secret.length} chars)`
}

function isProbablyBinary(path: string, buf: Buffer): boolean {
  if (/\.(db|db-.*|png|jpe?g|gif|webp|ico|woff2?|ttf|mp3|wav|ogg|zip|gz|tar|pdf)$/i.test(path)) return true
  return buf.subarray(0, 1024).includes(0)
}

function stagedFiles(): string[] {
  const res = spawnSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
    encoding: 'utf-8',
  })
  if (res.status !== 0) return [] // not a git repo / no staged set — nothing to guard
  return res.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
}

/** Phase 3-a (scripts/ci.ts): every TRACKED text file — the honest whole-repo
 *  mode for CI (the staged-set mode only covers a commit in flight). */
function trackedFiles(): string[] {
  const res = spawnSync('git', ['ls-files'], { encoding: 'utf-8' })
  if (res.status !== 0) return []
  return res.stdout.split('\n').map((l) => l.trim()).filter(Boolean)
}

// ---- CLI (used by hooks/pre-commit + scripts/ci.ts + github-service.ts) ----
// Usage: bun scripts/secret-scan.ts [--allow=substring]… [--tracked | --dir=<path>]
//   --dir=<path>: every text file under a directory tree (the outbound
//                 GitHub-mirror gate — exit 1 on any finding, fail-closed)
if (import.meta.main) {
  const allowlist = process.argv
    .filter((a) => a.startsWith('--allow='))
    .map((a) => a.slice('--allow='.length))
  const useTracked = process.argv.includes('--tracked')
  const dirArg = process.argv.find((a) => a.startsWith('--dir='))

  if (dirArg) {
    const root = dirArg.slice('--dir='.length)
    const skipDirs = new Set(['.git', 'node_modules'])
    const dirFiles: string[] = []
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name)
        if (e.isDirectory()) {
          if (!skipDirs.has(e.name)) walk(p)
        } else if (e.isFile()) {
          dirFiles.push(p)
        }
      }
    }
    walk(root)
    let dirty = 0
    let scanned = 0
    for (const file of dirFiles) {
      let buf: Buffer
      try {
        buf = readFileSync(file)
      } catch {
        continue
      }
      if (buf.length > 2_000_000 || isProbablyBinary(file, buf)) continue
      scanned++
      const findings = scanText(buf.toString('utf-8'), allowlist)
      for (const f of findings) {
        console.error(`✋ ${relative(root, file)}:${f.line} — ${f.kind}: ${redact(f.match)}`)
        dirty++
      }
    }
    if (dirty > 0) {
      console.error(`\nsecret-scan: ${dirty} finding(s) under ${root} — SYNC REFUSED (fail-closed).`)
      process.exit(1)
    }
    console.log(`secret-scan: clean (${scanned} file(s) under ${root})`)
    process.exit(0)
  }

  const files = useTracked ? trackedFiles() : stagedFiles()
  const mode = useTracked ? `tracked (${files.length} file(s))` : `staged (${files.length} file(s))`
  let dirty = 0
  for (const file of files) {
    let buf: Buffer
    try {
      buf = readFileSync(file)
    } catch {
      continue // deleted-between-stage-and-hook, unreadable, or a submodule path
    }
    if (buf.length > 2_000_000 || isProbablyBinary(file, buf)) continue
    const findings = scanText(buf.toString('utf-8'), allowlist)
    for (const f of findings) {
      console.error(`✋ ${file}:${f.line} — ${f.kind}: ${redact(f.match)}`)
      dirty++
    }
  }
  if (dirty > 0) {
    console.error(
      `\nsecret-scan: ${dirty} finding(s) in the ${useTracked ? 'tracked set' : 'staged set'} — ${useTracked ? 'CI failed.' : 'commit refused.'}` +
        `\n  · real secret? rotate it NOW, then commit the rotation.` +
        `\n  · known-safe fixture? commit with --allow=<substring of the value>:` +
        `\n      git commit --no-verify is DISABLED by policy; use the hook's allowlist instead.`
    )
    process.exit(1)
  }
  console.log(`secret-scan: clean (${mode} checked)`)
}
