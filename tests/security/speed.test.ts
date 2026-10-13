// Phase 4-a · Speed — source-of-truth scans + live events check.
//
// The speed work is structural (dynamic imports, splits, sprite cache,
// audio off React) — these tests pin the STRUCTURE so a future wave cannot
// silently regress it: the store must not regain hot audio writes, the
// drawer must keep every tab lazy, chat-panel must stay split, the canvas
// tick must not rebuild gradients, and /api/mist/events must stream.
// Run: bun test tests/security/speed.test.ts

import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const read = (rel: string): string =>
  readFileSync(path.join(process.cwd(), rel), 'utf8')

describe('audio off React (P3 / DoD: 0 store commits per energy tick)', () => {
  test('store.ts no longer defines a hot setAudioEnergy field write', () => {
    const src = read('src/lib/store.ts')
    expect(src.includes('setAudioEnergy:')).toBe(false)
  })

  test('no 120ms-class energy interval remains in chat-panel or voice-stage', () => {
    for (const rel of [
      'src/components/mist/consciousness/chat-panel.tsx',
      'src/components/mist/consciousness/voice-stage.tsx',
    ]) {
      const src = read(rel)
      // the old pattern: setInterval(…, 120) (±10) writing energy anywhere
      const hot = src.match(/setInterval\([^)]*\b1[1-3]\d\b/)
      expect(hot).toBeNull()
    }
  })

  test('the audio bus is the energy source (subscribers, not store writes)', () => {
    const bus = read('src/lib/audio-bus.ts')
    expect(bus.includes('mistAudioEnergy') || bus.includes('energy')).toBe(true)
  })
})

describe('dynamic imports (P1: mount active only, keep mounted)', () => {
  test('every diagnostics tab body is a lazyTab application', () => {
    const src = read('src/components/mist/diagnostics/drawer.tsx')
    const lazy = src.match(/lazyTab\(/g)?.length ?? 0
    expect(lazy).toBeGreaterThanOrEqual(15)
    expect(src.includes('next/dynamic')).toBe(true)
  })

  test('heavy surfaces are dynamically imported in the shell', () => {
    const src = read('src/components/mist/app-shell.tsx')
    expect(src.includes('next/dynamic')).toBe(true)
    // the palette + at least two heavy views are dynamic calls
    const dyn = src.match(/dynamic\(/g)?.length ?? 0
    expect(dyn).toBeGreaterThanOrEqual(2)
  })
})

describe('chat-panel split (god-file rule)', () => {
  test('chat-panel.tsx is a shell, not the old 2183-line god file', () => {
    const src = read('src/components/mist/consciousness/chat-panel.tsx')
    const lines = src.split('\n').length
    expect(lines).toBeLessThanOrEqual(800)
  })

  test('the five mandated pieces exist as siblings', () => {
    for (const rel of [
      'src/components/mist/consciousness/composer.tsx',
      'src/components/mist/consciousness/message-list.tsx',
      'src/components/mist/consciousness/mic-controller.tsx',
      'src/components/mist/consciousness/tts-orchestrator.tsx',
      'src/components/mist/consciousness/media-tabs.tsx',
    ]) {
      expect(() => read(rel)).not.toThrow()
    }
  })

  test('message-list applies content-visibility to message items', () => {
    const src = read('src/components/mist/consciousness/message-list.tsx')
    expect(src.includes('content-visibility')).toBe(true)
    expect(src.includes('contain-intrinsic-size')).toBe(true)
  })
})

describe('canvas sprite cache (P4: zero per-frame gradient construction)', () => {
  test('gradient construction lives ONLY inside buildOrbSprites', () => {
    const src = read('src/components/mist/consciousness/neural-core.tsx')
    const buildStart = src.indexOf('function buildOrbSprites')
    expect(buildStart).toBeGreaterThan(-1)
    // the builder closes at its return — find the span end the same way the
    // tabboundary scanner does (the function is the region before drawSprite)
    const spanEnd = src.indexOf('const drawSprite', buildStart)
    expect(spanEnd).toBeGreaterThan(buildStart)
    const builder = src.slice(buildStart, spanEnd)
    const rest = src.slice(0, buildStart) + src.slice(spanEnd)
    // all gradient construction is in the builder; none anywhere else
    const outside = rest.match(/create(Radial|Linear)Gradient\s*\(/g)
    expect(outside).toBeNull()
    // and the builder itself constructs them via its mk() helper (the point
    // of the cache — the two literal call sites feed every sprite layer)
    expect(builder.match(/create(Radial|Linear)Gradient\s*\(/g)?.length ?? 0).toBeGreaterThanOrEqual(2)
  })

  test('no shadowBlur ASSIGNMENT remains in the render path (comments ok)', () => {
    const src = read('src/components/mist/consciousness/neural-core.tsx')
    const assigns = src.match(/\.shadowBlur\s*=\s*[^=]/g)
    expect(assigns).toBeNull()
  })
})

describe('/api/mist/events (R11: one change stream, not per-mount pollers)', () => {
  test('the route answers SSE with a first payload quickly', async () => {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 5000)
    const res = await fetch('http://127.0.0.1:3000/api/mist/events', {
      signal: ctrl.signal,
      headers: { accept: 'text/event-stream' },
    }).catch(() => null)
    expect(res?.status).toBe(200)
    expect(res?.headers.get('content-type') ?? '').toContain('text/event-stream')
    // read the first chunk (the initial state event) then stop
    const reader = res!.body?.getReader()
    expect(reader).toBeTruthy()
    const first = await reader!.read()
    clearTimeout(t)
    const text = new TextDecoder().decode(first.value ?? new Uint8Array())
    expect(text.length).toBeGreaterThan(0)
    ctrl.abort()
    try {
      await reader!.cancel()
    } catch {
      /* abort race is fine */
    }
  })

  test('the UI hooks consume the stream instead of interval polling', () => {
    const events = read('src/hooks/use-events.ts')
    expect(events.includes('EventSource')).toBe(true)
    // the alerts hook no longer owns a 30s poll interval
    const alerts = read('src/hooks/use-alerts.ts')
    const poll = alerts.match(/setInterval\(/g)?.length ?? 0
    expect(poll).toBe(0)
  })
})
