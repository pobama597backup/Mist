// M.I.S.T. config service — env presence reporting (never secrets) + merge-write to .env
import fs from 'node:fs/promises'
import path from 'node:path'
import { recordActivity } from './activity-service'
import type { EnvPresenceResponse, EnvVarPresence } from '@/lib/types'

const ENV_KEYS = [
  'MIST_LLM_PROVIDER',
  'MIST_LLM_MODEL',
  'MIST_CORE_TEXT_MODEL',
  'MIST_CORE_VISION_MODEL',
  'MIST_NOUS_API_KEY',
  'MIST_NOUS_BASE_URL',
  'MIST_NOUS_MODEL',
  'MIST_QWEN_API_KEY',
  'MIST_QWEN_BASE_URL',
  'MIST_QWEN_MODEL',
  'MIST_QWEN_VISION_MODEL',
  'MIST_OPENCLAW_AUTO_UPDATE',
  'MIST_EVOLUTION_INTERVAL_H',
  'MIST_EVOLUTION_AUTO_SUGGEST',
  'OMNIROUTE_BASE_URL',
  'OMNIROUTE_API_KEY',
  'OMNIROUTE_MODEL',
  'OPENAI_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_MODEL',
  'OPENROUTER_API_KEY',
  'OPENROUTER_MODEL',
  'NVIDIA_API_KEY',
  'NVIDIA_MODEL',
  'THEOLD_API_KEY',
  'THEOLD_MODEL',
  'GROQ_API_KEY',
  'GROQ_MODEL',
  'GITHUB_MODELS_KEY',
  'GITHUB_MODELS_MODEL',
  'CEREBRAS_API_KEY',
  'CEREBRAS_MODEL',
  'TOGETHER_API_KEY',
  'TOGETHER_MODEL',
  'MISTRAL_API_KEY',
  'MISTRAL_MODEL',
  'HUGGINGFACE_API_KEY',
  'HUGGINGFACE_MODEL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_MODEL',
  'GEMINI_API_KEY',
  'GEMINI_MODEL',
  // keyless zero-auth lanes (optional BYOK raises limits; models selectable)
  'MIST_KEYLESS',
  'KILO_API_KEY',
  'KILO_MODEL',
  'POLLINATIONS_TOKEN',
  'POLLINATIONS_MODEL',
  'LLM7_TOKEN',
  'LLM7_MODEL',
  'OVH_API_KEY',
  'OVH_MODEL',
] as const

const KEY_PATTERN =
  /^((MIST|OMNIROUTE|OPENAI|OPENROUTER|NVIDIA|ANTHROPIC|GEMINI|GOOGLE|THEOLD|GROQ|GITHUB|CEREBRAS|TOGETHER|MISTRAL|HUGGINGFACE|KILO|POLLINATIONS|LLM7|OVH)_[A-Z0-9_]+)$/

function envFilePath(): string {
  return path.join(process.cwd(), '.env')
}

/** Presence report. Secret keys (name contains 'KEY') never expose their value. */
export function getEnvPresence(): EnvPresenceResponse {
  const vars: EnvVarPresence[] = ENV_KEYS.map((name) => {
    const raw = process.env[name]
    const present = typeof raw === 'string' && raw.length > 0
    if (name.includes('KEY')) return { name, present }
    return { name, present, ...(present ? { value: raw } : {}) }
  })
  return { vars }
}

export interface EnvSetResult {
  success: boolean
  applied: string[]
  error?: string
}

/**
 * Merge-write vars to .env (preserving unrelated lines, updating existing keys),
 * mirror into process.env. Values are NEVER echoed back.
 */
export async function setEnvVars(
  vars: unknown,
  confirmed: unknown
): Promise<EnvSetResult> {
  if (confirmed !== true) {
    return { success: false, applied: [], error: 'confirmation required' }
  }
  if (!vars || typeof vars !== 'object' || Array.isArray(vars)) {
    return { success: false, applied: [], error: 'vars must be an object of key/value pairs' }
  }
  const entries = Object.entries(vars as Record<string, unknown>)
  if (entries.length === 0) {
    return { success: false, applied: [], error: 'no vars provided' }
  }
  for (const [key, value] of entries) {
    if (!KEY_PATTERN.test(key)) {
      return { success: false, applied: [], error: `invalid key name: ${key}` }
    }
    if (typeof value !== 'string') {
      return { success: false, applied: [], error: `value for ${key} must be a string` }
    }
    if (value.includes('\n') || value.includes('\r')) {
      return { success: false, applied: [], error: `value for ${key} must be a single line` }
    }
  }

  const file = envFilePath()
  let existing = ''
  try {
    existing = await fs.readFile(file, 'utf-8')
  } catch {
    // no .env yet — create fresh
  }

  const lines = existing.length > 0 ? existing.split('\n') : []
  // drop a single trailing empty element caused by a final newline
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  const applied: string[] = []
  for (const [key, value] of entries as [string, string][]) {
    const prefix = `${key}=`
    const idx = lines.findIndex((l) => l.startsWith(prefix) || l.startsWith(`${key} =`))
    if (idx >= 0) lines[idx] = `${key}=${value}`
    else lines.push(`${key}=${value}`)
    process.env[key] = value
    applied.push(key)
  }

  await fs.writeFile(file, `${lines.join('\n')}\n`, 'utf-8')
  recordActivity('config', `env updated: ${applied.join(', ')}`)
  return { success: true, applied }
}

// ---------- provider-key self-heal (sandbox snapshot recovery) ----------
// The sandbox regenerates .env to a stub on snapshot restore, but db/ survives.
// db/provider-keys.json holds a backup; when keys go missing from process.env
// we restore them (mirror to process.env + merge-write .env so cold boots keep them).

const PROVIDER_KEY_NAMES = [
  'OPENROUTER_API_KEY',
  'NVIDIA_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'OPENAI_API_KEY',
  'OMNIROUTE_API_KEY',
  'MIST_QWEN_API_KEY',
  'MIST_NOUS_API_KEY',
  'THEOLD_API_KEY',
  'GROQ_API_KEY',
  'GITHUB_MODELS_KEY',
  'CEREBRAS_API_KEY',
  'TOGETHER_API_KEY',
  'MISTRAL_API_KEY',
  'HUGGINGFACE_API_KEY',
  // keyless lanes are zero-auth, but optional BYOK keys deserve the same
  // snapshot-restore protection when the creator adds them
  'KILO_API_KEY',
  'POLLINATIONS_TOKEN',
  'LLM7_TOKEN',
  'OVH_API_KEY',
] as const

const KEY_BACKUP_PATH = path.join(process.cwd(), 'db', 'provider-keys.json')

let keysRestorePromise: Promise<void> | null = null

async function restoreProviderKeys(): Promise<void> {
  const missing = PROVIDER_KEY_NAMES.filter((k) => !process.env[k]?.trim())
  if (missing.length === 0) return
  let backup: Record<string, unknown>
  try {
    backup = JSON.parse(await fs.readFile(KEY_BACKUP_PATH, 'utf-8'))
  } catch {
    return // no backup present — nothing to heal from
  }
  const toRestore: Record<string, string> = {}
  for (const k of missing) {
    const v = backup[k]
    if (typeof v === 'string' && v.trim()) toRestore[k] = v.trim()
  }
  if (Object.keys(toRestore).length === 0) return
  const res = await setEnvVars(toRestore, true)
  if (res.success) {
    recordActivity('config', `provider keys self-restored from db backup: ${res.applied.join(', ')}`)
  }
}

/** One-shot self-heal, safe to call from any async entry point. Never throws. */
export function ensureProviderKeysRestored(): Promise<void> {
  keysRestorePromise ??= restoreProviderKeys().catch(() => {})
  return keysRestorePromise
}
