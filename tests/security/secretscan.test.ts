// Phase 1 · S9 — unit tests for scripts/secret-scan.ts scanText().
//
// The fixture secrets are ASSEMBLED at runtime (never present as one literal
// in this file) so the pre-commit scanner — which scans staged file content —
// never sees a real-shaped secret in the test file itself.
import { test, expect } from 'bun:test'
import { scanText } from '../../scripts/secret-scan'

// assembled fixtures (no literal pattern match in THIS file's text)
const SK = ['sk-', 'Abcdefghij', 'Klmnopqrst', '1234'].join('')
const GHP = ['ghp_', 'Abcdefghij', 'Klmnopqrst', '5678'].join('')
const GHP_PAT = ['github_pat_', '11ABCDEFghij', 'klmnopqrstuv'].join('')
const NVAPI = ['nvapi-', 'Abcdefghij-klmnop', 'qrstuv12345'].join('')
const XAI = ['xai-', 'AbcdefghijKlmnopq', 'rst12'].join('')
const AIZA = ['AIza', 'AbcdefghijKlmnopqrst', '12'].join('')
const KEYASSIGN = 'MIST_TEST_API_KEY=' + ['Abcdefghij', 'Klmnopqrstuv', 'wxyz998877'].join('')

test('S9 · scanText flags every mandated secret shape', () => {
  const cases: Array<[string, RegExp]> = [
    [`const k = "${SK}"`, /sk-/],
    [`token: ${GHP}`, /ghp_/],
    [`pat = "${GHP_PAT}"`, /github_pat_/],
    [`nvidia ${NVAPI} end`, /nvapi-/],
    [`xai key ${XAI}`, /xai-/],
    [`google ${AIZA} done`, /^AIza/],
    [KEYASSIGN, /KEY/],
  ]
  for (const [text, kindRe] of cases) {
    const findings = scanText(text)
    expect(findings.length).toBeGreaterThan(0)
    expect(findings[0].kind).toMatch(kindRe)
    expect(findings[0].line).toBe(1)
  }
})

test('S9 · scanText reports the right line numbers', () => {
  const text = ['line one is fine', 'nothing here either', `export const K = "${GHP}"`].join('\n')
  const findings = scanText(text)
  expect(findings.length).toBe(1)
  expect(findings[0].line).toBe(3)
})

test('S9 · scanText stays quiet on benign text', () => {
  expect(scanText('const safe = "hello world"')).toEqual([])
  expect(scanText('MIST_ALLOW_REMOTE_BRIDGE=1')).toEqual([]) // short value — a flag, not a secret
  expect(scanText('read the README.md file, please')).toEqual([])
  expect(scanText('the sk- prefix alone is not a key')).toEqual([])
  expect(scanText('KEY=short')).toEqual([]) // under the 20-char value floor
})

test('S9 · the allowlist suppresses findings whose match contains an entry', () => {
  const text = `token = ${SK}`
  expect(scanText(text, [SK])).toEqual([])
  // partial allowlist entry (substring of the secret) also suppresses
  expect(scanText(text, ['Abcdefghij'])).toEqual([])
  // an unrelated allowlist entry does NOT suppress
  const still = scanText(text, ['totally-other-value'])
  expect(still.length).toBe(1)
})
