// M.I.S.T. agent bridge — delegate tasks to external CLI coding agents
// (Claude Code, Codex, Gemini CLI, Aider) WITHOUT the user opening them.
// Honest by design: agents that are not installed on this machine are reported
// as not-installed, never faked. On the user's local deployment with the CLI
// installed, delegation runs headless and returns real output.

import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export interface AgentDef {
  id: string
  label: string
  cmd: string
  installHint: string
  delegate: 'headless' | 'interactive-only'
  /** Build the argv for a headless task run. Task is passed as ONE argv element (no shell). */
  taskArgs: (task: string) => string[]
  versionArgs?: string[]
}

export const AGENT_REGISTRY: AgentDef[] = [
  {
    id: 'openclaw',
    label: 'OpenClaw',
    cmd: 'openclaw',
    installHint: 'npm install -g openclaw@latest',
    delegate: 'headless',
    // documented headless entry point: one embedded agent turn, no Gateway needed
    taskArgs: (task) => ['agent', 'exec', task],
    versionArgs: ['--version'],
  },
  {
    id: 'claude-code',
    label: 'Claude Code',
    cmd: 'claude',
    installHint: 'npm install -g @anthropic-ai/claude-code',
    delegate: 'headless',
    taskArgs: (task) => ['-p', task, '--output-format', 'text'],
    versionArgs: ['--version'],
  },
  {
    id: 'codex',
    label: 'OpenAI Codex CLI',
    cmd: 'codex',
    installHint: 'npm install -g @openai/codex',
    delegate: 'headless',
    taskArgs: (task) => ['exec', '--skip-git-repo-check', task],
    versionArgs: ['--version'],
  },
  {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    cmd: 'gemini',
    installHint: 'npm install -g @google/gemini-cli',
    delegate: 'headless',
    taskArgs: (task) => ['-p', task],
    versionArgs: ['--version'],
  },
  {
    id: 'aider',
    label: 'Aider',
    cmd: 'aider',
    installHint: 'python -m pip install aider-chat',
    delegate: 'interactive-only',
    taskArgs: () => [],
    versionArgs: ['--version'],
  },
]

// ---------- probe (cached 60s) ----------

export interface AgentStatus {
  id: string
  label: string
  cmd: string
  installed: boolean
  version: string | null
  delegate: 'headless' | 'interactive-only'
  install_hint: string
}

let probeCache: { at: number; agents: AgentStatus[] } | null = null
const PROBE_TTL_MS = 60_000

async function whichInstalled(cmd: string): Promise<boolean> {
  try {
    await execFileP('which', [cmd], { timeout: 5000 })
    return true
  } catch {
    return false
  }
}

async function probeVersion(cmd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileP(cmd, args, { timeout: 8000 })
    return stdout.trim().split('\n')[0].slice(0, 80) || null
  } catch {
    return null
  }
}

export async function probeAgents(): Promise<AgentStatus[]> {
  if (probeCache && Date.now() - probeCache.at < PROBE_TTL_MS) return probeCache.agents
  const agents: AgentStatus[] = await Promise.all(
    AGENT_REGISTRY.map(async (a) => {
      const installed = await whichInstalled(a.cmd)
      const version = installed && a.versionArgs ? await probeVersion(a.cmd, a.versionArgs) : null
      return {
        id: a.id,
        label: a.label,
        cmd: a.cmd,
        installed,
        version,
        delegate: a.delegate,
        install_hint: a.installHint,
      }
    })
  )
  probeCache = { at: Date.now(), agents }
  return agents
}

export function invalidateAgentProbe(): void {
  probeCache = null
}

// ---------- delegation ----------

export interface DelegateResult {
  agent: string
  installed: boolean
  ok: boolean
  output: string
  exit_code: number | null
  duration_ms: number
  error?: string
}

const OUTPUT_CAP = 50_000
const DEFAULT_TIMEOUT_MS = 120_000

export async function delegateTask(agentId: string, task: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<DelegateResult> {
  const startedAt = Date.now()
  const def = AGENT_REGISTRY.find((a) => a.id === agentId)
  if (!def) {
    return { agent: agentId, installed: false, ok: false, output: '', exit_code: null, duration_ms: 0, error: `unknown agent "${agentId}"` }
  }
  const installed = await whichInstalled(def.cmd)
  if (!installed) {
    return {
      agent: def.id,
      installed: false,
      ok: false,
      output: '',
      exit_code: null,
      duration_ms: Date.now() - startedAt,
      error: `${def.label} is not installed on this machine. Install: ${def.installHint}`,
    }
  }
  if (def.delegate !== 'headless') {
    return {
      agent: def.id,
      installed: true,
      ok: false,
      output: '',
      exit_code: null,
      duration_ms: Date.now() - startedAt,
      error: `${def.label} is interactive-only and cannot run headless tasks.`,
    }
  }

  return new Promise<DelegateResult>((resolve) => {
    // shell:false + argv array — the task is never interpreted by a shell.
    const child = spawn(def.cmd, def.taskArgs(task), {
      cwd: '/home/z/my-project',
      shell: false,
      env: { ...process.env, NO_COLOR: '1' },
    })

    let out = ''
    let settled = false
    const finish = (result: DelegateResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish({
        agent: def.id,
        installed: true,
        ok: false,
        output: out.slice(0, OUTPUT_CAP),
        exit_code: null,
        duration_ms: Date.now() - startedAt,
        error: `timed out after ${timeoutMs / 1000}s`,
      })
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      if (out.length < OUTPUT_CAP) out += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (out.length < OUTPUT_CAP) out += `\n[stderr] ${chunk.toString()}`
    })
    child.on('error', (err) => {
      finish({
        agent: def.id,
        installed: true,
        ok: false,
        output: out.slice(0, OUTPUT_CAP),
        exit_code: null,
        duration_ms: Date.now() - startedAt,
        error: err.message,
      })
    })
    child.on('close', (code) => {
      finish({
        agent: def.id,
        installed: true,
        ok: code === 0,
        output: out.slice(0, OUTPUT_CAP).trim(),
        exit_code: code,
        duration_ms: Date.now() - startedAt,
      })
    })
  })
}
