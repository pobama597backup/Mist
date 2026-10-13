// Phase 2-d · pilot hardening + sensitive-read redaction + voice-exec tests.
//
// Written RED first against three layers:
//   PURE   — mini-services/lib/url-guard.ts (the in-service SSRF validator the
//            browser pilot imports; injectable DNS lookup for the rebind case)
//   LIVE   — the respawned pilot daemon on :3030 (Bearer-authed v2.0: task
//            model with per-task incognito contexts, /health {contexts})
//   APP    — redactSensitive/redactBeforeCloud/needsCloudConsent (guardrails,
//            the 2-c wrap seam) + the S14 voice confirm matcher (voice-confirm)
//
// Run: bun test tests/security/pilot.test.ts (pilot :3030 + dev server up)
import { test, expect, describe } from 'bun:test'
import { validateUrl } from '../../mini-services/lib/url-guard'
import { getMistSecrets } from '../../src/lib/perimeter/shared'
import {
  redactSensitive,
  redactBeforeCloud,
  markCloudConsent,
  needsCloudConsent,
} from '../../src/lib/oj/guardrails'
import {
  matchVoiceConfirm,
  shouldApproveByVoice,
  VOICE_CONFIRM_WINDOW_MS,
  MIST_VOICE_CONFIRM_PHRASE,
} from '../../src/lib/voice-confirm'

const PILOT = 'http://127.0.0.1:3030'
const bearer = () => ({ Authorization: `Bearer ${getMistSecrets().bridgeToken}` })

// ---------------------------------------------------------------------------
// PURE · the in-service SSRF validator
// ---------------------------------------------------------------------------

describe('pilot url-guard (pure)', () => {
  test('refuses the cloud-metadata IP 169.254.169.254', async () => {
    const v = await validateUrl('http://169.254.169.254/latest/meta-data')
    expect(v.ok).toBe(false)
    expect(v.reason ?? '').toContain('refused')
    expect(v.reason ?? '').toContain('169.254.169.254')
  })

  test('refuses loopback literals (127.0.0.1:3000)', async () => {
    const v = await validateUrl('http://127.0.0.1:3000')
    expect(v.ok).toBe(false)
    expect(v.reason ?? '').toContain('refused')
  })

  test('refuses private 10/8', async () => {
    const v = await validateUrl('http://10.0.0.5')
    expect(v.ok).toBe(false)
    expect(v.reason ?? '').toContain('10.0.0.5')
  })

  test('refuses private 192.168/16', async () => {
    const v = await validateUrl('http://192.168.1.1')
    expect(v.ok).toBe(false)
  })

  test('refuses private 172.16/12', async () => {
    const v = await validateUrl('http://172.16.0.9/admin')
    expect(v.ok).toBe(false)
  })

  test('refuses IPv6 loopback [::1]', async () => {
    const v = await validateUrl('http://[::1]/')
    expect(v.ok).toBe(false)
    expect(v.reason ?? '').toContain('refused')
  })

  test('refuses IPv4-mapped IPv6 (::ffff:127.0.0.1)', async () => {
    const v = await validateUrl('http://[::ffff:127.0.0.1]/')
    expect(v.ok).toBe(false)
  })

  test('DNS-rebinding: public first resolution ok, private second resolution refused', async () => {
    const answers: string[][] = [['93.184.216.34'], ['10.0.0.5']]
    const lookup = async () => answers.shift() ?? ['10.0.0.5']
    const first = await validateUrl('http://rebind.example.com/x', { lookup })
    expect(first.ok).toBe(true)
    expect(first.addresses).toEqual(['93.184.216.34'])
    // the PIN re-check: a second resolution that answers private ABORTS
    const second = await validateUrl('http://rebind.example.com/x', { lookup })
    expect(second.ok).toBe(false)
    expect(second.reason ?? '').toContain('10.0.0.5')
  })

  test('fail-closed on unresolvable hostnames', async () => {
    const lookup = async () => {
      throw new Error('ENOTFOUND')
    }
    const v = await validateUrl('http://this-host-does-not-exist.invalid/', { lookup })
    expect(v.ok).toBe(false)
    expect(v.reason ?? '').toContain('refused')
  })

  test('MIST_LAN=1 allows private ranges but STILL refuses 169.254.169.254', async () => {
    const lan = await validateUrl('http://192.168.1.1', { mistLan: true })
    expect(lan.ok).toBe(true)
    const meta = await validateUrl('http://169.254.169.254/latest/meta-data', { mistLan: true })
    expect(meta.ok).toBe(false)
    expect(meta.reason ?? '').toContain('169.254.169.254')
  })

  test('a public IP literal passes (the control case)', async () => {
    const v = await validateUrl('http://93.184.216.34/')
    expect(v.ok).toBe(true)
    expect(v.addresses).toEqual(['93.184.216.34'])
  })

  test.each(['file:///etc/passwd', 'chrome://settings', 'javascript:alert(1)', 'data:text/html,<h1>x</h1>', 'chrome-extension://abc/x.html', 'about:blank'])(
    'refuses non-browsable scheme %s',
    async (raw) => {
      const v = await validateUrl(raw)
      expect(v.ok).toBe(false)
      expect(v.reason ?? '').toContain('refused')
    },
  )
})

// ---------------------------------------------------------------------------
// LIVE · the respawned :3030 daemon (v2.0, Bearer-gated task endpoints)
// ---------------------------------------------------------------------------

describe('live pilot :3030 (v2.0 hardened)', () => {
  test(
    'no-auth task call → 401',
    async () => {
      const res = await fetch(`${PILOT}/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'http://example.com' }),
      })
      expect(res.status).toBe(401)
    },
    10_000,
  )

  test(
    '/health stays open and reports version 2.0 + a contexts counter',
    async () => {
      const res = await fetch(`${PILOT}/health`)
      expect(res.status).toBe(200)
      const h = (await res.json()) as { version?: string; contexts?: number; status?: string }
      expect(h.status).toBe('ok')
      expect(h.version).toBe('2.0.0')
      expect(typeof h.contexts).toBe('number')
    },
    10_000,
  )

  test(
    'authed task on a refused target → honest refused error (SSRF enforced in-service)',
    async () => {
      const res = await fetch(`${PILOT}/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...bearer() },
        body: JSON.stringify({ url: 'http://169.254.169.254/latest/meta-data' }),
      })
      const body = (await res.json()) as { ok: boolean; error?: string }
      expect(res.status).toBe(403)
      expect(body.ok).toBe(false)
      expect(/refused|blocked/i.test(body.error ?? '')).toBe(true)
    },
    15_000,
  )

  test(
    'scheme-blocked target (file:) → honest refused error',
    async () => {
      const res = await fetch(`${PILOT}/navigate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...bearer() },
        body: JSON.stringify({ url: 'file:///etc/passwd' }),
      })
      const body = (await res.json()) as { ok: boolean; error?: string }
      expect(res.status).toBe(403)
      expect(body.ok).toBe(false)
      expect(/refused|blocked/i.test(body.error ?? '')).toBe(true)
    },
    15_000,
  )

  test(
    'per-task incognito lifecycle: /elements opens a context, /task/close closes it, /health contexts → 0',
    async () => {
      // open a real task context (launches chromium on first use)
      const open = await fetch(`${PILOT}/elements`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...bearer() },
        body: JSON.stringify({}),
      })
      expect(open.status).toBe(200)
      const opened = (await open.json()) as { ok: boolean; taskId?: string; elements?: unknown[] }
      expect(opened.ok).toBe(true)
      expect(typeof opened.taskId).toBe('string')

      const mid = (await (await fetch(`${PILOT}/health`)).json()) as { contexts?: number }
      expect((mid.contexts ?? 0)).toBeGreaterThanOrEqual(1)

      // explicit end — the finally-equivalent close
      const close = await fetch(`${PILOT}/task/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...bearer() },
        body: JSON.stringify({ taskId: opened.taskId }),
      })
      expect(close.status).toBe(200)
      const closed = (await close.json()) as { ok: boolean; closed?: number }
      expect(closed.ok).toBe(true)
      expect(closed.closed).toBe(1)

      const after = (await (await fetch(`${PILOT}/health`)).json()) as { contexts?: number }
      expect(after.contexts).toBe(0)
    },
    60_000,
  )

  test(
    'after all tasks, /health reports contexts: 0 (nothing leaks)',
    async () => {
      const h = (await (await fetch(`${PILOT}/health`)).json()) as { contexts?: number }
      expect(h.contexts).toBe(0)
    },
    10_000,
  )
})

// ---------------------------------------------------------------------------
// APP · S13 sensitive-read redaction before cloud lanes
// ---------------------------------------------------------------------------

describe('sensitive-read redaction (S13)', () => {
  // fake fixtures assembled at RUNTIME (secretscan.test.ts convention) — no
  // literal credential shape ever appears in this file's source text
  const SK = ['sk-AbCdEf', '1234567890GhIjKl'].join('')
  const GHP = ['ghp_', 'abcdefghij', 'klmnopqrstuv', 'wxyz'].join('')
  const GHP_PAT = ['github_pat_', '11ABCDEFG0ab', 'cdefghij_0123', '456789abcdefghij'].join('')
  const NVAPI = ['nvapi-', '0123456789ab', 'cdefghijklmn'].join('')
  const XAI = ['xai-', '0123456789ab', 'cdefghijk'].join('')
  const AIZA = ['AIza', 'SyA123456789a', 'bcdefghijklmnopq'].join('')

  test('redacts sk- shaped API keys', () => {
    const out = redactSensitive(`the key is ${SK} plus trailing words`)
    expect(out.text).toContain('[REDACTED:api-key]')
    expect(out.text).not.toContain('sk-AbCdEf')
    expect(out.redactions).toBeGreaterThanOrEqual(1)
  })

  test('redacts ghp_/github_pat_/nvapi-/xai-/AIza key shapes', () => {
    const src = [GHP, GHP_PAT, NVAPI, XAI, AIZA].join(' | ')
    const out = redactSensitive(src)
    expect(out.text).not.toContain('ghp_')
    expect(out.text).not.toContain('github_pat_')
    expect(out.text).not.toContain('nvapi-')
    expect(out.text).not.toContain('xai-')
    expect(out.text).not.toContain('AIza')
    expect(out.redactions).toBeGreaterThanOrEqual(5)
  })

  test('redacts PEM blocks wholesale', () => {
    const pem =
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA1example\n-----END RSA PRIVATE KEY-----'
    const out = redactSensitive(`cert:\n${pem}\nafter`)
    expect(out.text).toContain('[REDACTED:pem]')
    expect(out.text).not.toContain('MIIEpAIBAAKCAQEA1example')
    expect(out.text).toContain('cert:')
    expect(out.text).toContain('after')
  })

  test('redacts Bearer tokens', () => {
    const out = redactSensitive('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.sig')
    expect(out.text).toContain('[REDACTED:bearer]')
  })

  test('redacts JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1'
    const out = redactSensitive(`token=${jwt} end`)
    expect(out.text).not.toContain(jwt)
  })

  test('redacts Luhn-valid PANs (4111111111111111)', () => {
    const out = redactSensitive('card 4111111111111111 expires 12/30')
    expect(out.text).toContain('[REDACTED:pan]')
    expect(out.text).toContain('expires 12/30')
  })

  test('does NOT redact Luhn-invalid 16-digit numbers (4111111111111112)', () => {
    const out = redactSensitive('ref 4111111111111112 stays')
    expect(out.text).toBe('ref 4111111111111112 stays')
    expect(out.redactions).toBe(0)
  })

  test('mixed text keeps the surrounding words', () => {
    const src = `The config has ${['API_KEY=', 'sk-AbCdEf', '1234567890Zz'].join('')} and nothing else`
    const out = redactSensitive(src)
    expect(out.text).toContain('The config has')
    expect(out.text).toContain('and nothing else')
  })

  test('redactBeforeCloud applies on sensitive-read + cloud lane', () => {
    const out = redactBeforeCloud('read_file', 'sensitive-read', ['sk-AbCdEf', '1234567890Qq'].join(''), true)
    expect(out.text).toContain('[REDACTED:api-key]')
    expect(out.redactions).toBeGreaterThanOrEqual(1)
  })

  test('redactBeforeCloud leaves read-risk output untouched even on a cloud lane', () => {
    const text = `plain read output with ${['sk-AbCdEf', '1234567890Rr'].join('')} inside`
    const out = redactBeforeCloud('web_search', 'network', text, true)
    expect(out.text).toBe(text)
    expect(out.redactions).toBe(0)
  })

  test('needsCloudConsent: marked turns flag, others do not, entries prune', () => {
    const turn = 'cloud-consent-test-turn'
    expect(needsCloudConsent(turn)).toBe(false)
    markCloudConsent(turn)
    expect(needsCloudConsent(turn)).toBe(true)
    expect(needsCloudConsent('cloud-consent-test-other')).toBe(false)
    // an expired entry stops flagging (window honored)
    markCloudConsent('cloud-consent-old')
    expect(needsCloudConsent('cloud-consent-old')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// APP · S14 voice confirm phrase (pure matcher)
// ---------------------------------------------------------------------------

describe('voice confirm phrase (S14)', () => {
  test('matches the confirm phrase case-insensitively with surrounding whitespace', () => {
    expect(matchVoiceConfirm('  Confirm And Run It ')).toBe(true)
    expect(MIST_VOICE_CONFIRM_PHRASE.length).toBeGreaterThan(0)
  })

  test('the wake word does NOT match (it is not the confirm phrase)', () => {
    expect(matchVoiceConfirm('hey mist')).toBe(false)
    expect(matchVoiceConfirm('Hey Mist, confirm and run it')).toBe(false) // whole-utterance match only — a wake-prefixed phrase is NOT a bare confirm
  })

  test('shouldApproveByVoice approves within the 60s window', () => {
    const now = Date.now()
    expect(
      shouldApproveByVoice('confirm and run it', { createdAt: new Date(now - 10_000).toISOString() }, now),
    ).toBe(true)
  })

  test('expired window (older than 60s) → no approve', () => {
    const now = Date.now()
    expect(
      shouldApproveByVoice('confirm and run it', { createdAt: new Date(now - VOICE_CONFIRM_WINDOW_MS - 1).toISOString() }, now),
    ).toBe(false)
  })
})
