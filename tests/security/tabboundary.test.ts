// Phase 3-b · TABBOUNDARY tests — the shared visibility store + the
// interval-cleanup source-of-truth scan.
//
//   STORE   createVisibilityStore semantics with an INJECTED fake document
//           (no jsdom): snapshot follows doc.hidden, flips fire subscribers,
//           same-value flips fire nothing, and the document listener arms
//           with the first subscriber and disarms with the last
//   CYCLES   the 20× mount/unmount invariant: subscribe/unsubscribe pairs
//           return the doc listener count to baseline — a hidden-tab flip
//           after the last unsubscribe must NOT move the snapshot (no
//           phantom listener) and stale callbacks must never fire
//   SCAN    source-of-truth (the defang-test pattern): every setInterval in
//           the four mandated boundary components + use-interval has its
//           clearInterval — effect-scoped timers inside the SAME useEffect
//           (balanced-paren span over a string/comment-aware mask),
//           ref-held timers cleared by name anywhere in the file; the
//           neural-core rAF loop pairs requestAnimationFrame with
//           cancelAnimationFrame. Honest limits: the scanner is AST-lite
//           (no type checking, no cross-file flow); it pins the cleanup
//           CONTRACT, not execution.
//
// Run: bun test tests/security/tabboundary.test.ts
import { test, expect, describe } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  createVisibilityStore,
  type VisibilityDocumentLike,
} from '../../src/lib/tab-visibility'

// ---------------------------------------------------------------- fake doc

interface FakeDoc extends VisibilityDocumentLike {
  setHidden(v: boolean): void
  counts(): { added: string[]; removed: string[]; live: number }
}

function fakeDoc(hidden = false): FakeDoc {
  let h = hidden
  const added: string[] = []
  const removed: string[] = []
  const listeners = new Set<() => void>()
  return {
    get hidden() {
      return h
    },
    setHidden(v: boolean) {
      h = v
      listeners.forEach((fn) => fn())
    },
    addEventListener(type: 'visibilitychange', fn: () => void) {
      added.push(type)
      listeners.add(fn)
    },
    removeEventListener(type: 'visibilitychange', fn: () => void) {
      removed.push(type)
      listeners.delete(fn)
    },
    counts: () => ({ added, removed, live: listeners.size }),
  }
}

// ---------------------------------------------------------------- store

describe('visibility store semantics (injected document)', () => {
  test('no-DOM store: always visible, subscribe is a no-op pair', () => {
    const store = createVisibilityStore(null)
    expect(store.getSnapshot()).toBe(true)
    let fired = 0
    const unsub = store.subscribe(() => {
      fired++
    })
    unsub()
    expect(fired).toBe(0)
  })

  test('snapshot follows the document; flips fire subscribers; no-op flips are silent', () => {
    const doc = fakeDoc(false)
    const store = createVisibilityStore(doc)
    expect(store.getSnapshot()).toBe(true)
    let fires = 0
    let last = true
    const unsub = store.subscribe(() => {
      fires++
      last = store.getSnapshot()
    })
    doc.setHidden(true)
    expect(fires).toBe(1)
    expect(last).toBe(false)
    expect(store.getSnapshot()).toBe(false)
    doc.setHidden(true) // same value — must not fire
    expect(fires).toBe(1)
    doc.setHidden(false)
    expect(fires).toBe(2)
    expect(store.getSnapshot()).toBe(true)
    unsub()
  })

  test('the document listener arms with the first subscriber and disarms with the last', () => {
    const doc = fakeDoc(false)
    const store = createVisibilityStore(doc)
    const u1 = store.subscribe(() => undefined)
    const u2 = store.subscribe(() => undefined)
    expect(doc.counts().live).toBe(1) // ONE listener for any subscriber count
    expect(doc.counts().added).toEqual(['visibilitychange'])
    u1()
    expect(doc.counts().live).toBe(1) // u2 still holds it
    u2()
    expect(doc.counts().live).toBe(0)
    expect(doc.counts().removed).toEqual(['visibilitychange'])
    expect(doc.counts().added.length).toBe(doc.counts().removed.length)
  })

  test('20 mount/unmount cycles: baseline restored, no phantom listener, stale callbacks silent', () => {
    const doc = fakeDoc(false)
    const store = createVisibilityStore(doc)
    let probeFires = 0
    const unsubProbe = store.subscribe(() => {
      probeFires++
    })
    for (let cycle = 0; cycle < 20; cycle++) {
      let mine = 0
      const unsubs = [
        store.subscribe(() => {
          mine++
        }),
        store.subscribe(() => {
          mine++
        }), // strict-mode double mount simulation
      ]
      doc.setHidden(true) // fires probe + 2 mine (both subscribed)
      expect(mine).toBe(2)
      unsubs.forEach((u) => u())
      doc.setHidden(false) // fires ONLY the probe
      expect(mine).toBe(2) // stale listeners stayed silent — no leak
    }
    expect(probeFires).toBe(40)
    expect(doc.counts().live).toBe(1) // the probe's listener
    unsubProbe()
    expect(doc.counts().live).toBe(0)
    // no subscriber remains: flipping the doc must NOT move the snapshot
    doc.setHidden(true)
    expect(store.getSnapshot()).toBe(true) // phantom listener would have flipped it
  })
})

// ------------------------------------------------------- interval-cleanup scan

/** A string/comment/template-aware "is this a real code char" mask, computed
 *  in one forward pass — regex literals are NOT handled (none of the scanned
 *  files carry parens inside a regex literal inside an effect; the span
 *  sanity checks below fail loudly if that ever changes). */
function codeMask(src: string): boolean[] {
  const mask = new Array<boolean>(src.length).fill(true)
  type Mode = 'code' | 'sq' | 'dq' | 'tpl' | 'line' | 'block'
  const stack: Mode[] = [] // template ${ … } nesting
  let mode: Mode = 'code'
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const n = src[i + 1]
    if (mode === 'code') {
      if (c === "'") {
        mode = 'sq'
        stack.push('code') // Phase 4-a fix: a quote inside a ${…} interpolation
        // must return to CODE, not pop the enclosing 'tpl' — without this
        // push, `${x ? 'a' : 'b'}` skewed the whole downstream mask and the
        // effect-span scanner failed to close (found live on neural-core).
        mask[i] = false
      } else if (c === '"') {
        mode = 'dq'
        stack.push('code') // same discipline for double quotes
        mask[i] = false
      } else if (c === '`') {
        mode = 'tpl'
        stack.push('code') // same discipline: a template INSIDE a ${…}
        // interpolation must return to code, not eat the enclosing 'tpl'
        // (nested templates were the second live skew, found on neural-core)
        mask[i] = false
      } else if (c === '}' && stack.length > 0) {
        // closing a template ${ … } interpolation — back into the literal
        mode = stack.pop() as 'tpl'
        mask[i] = false
      } else if (c === '/' && n === '/') {
        mode = 'line'
        mask[i] = mask[i + 1] = false
        i++
      } else if (c === '/' && n === '*') {
        mode = 'block'
        mask[i] = mask[i + 1] = false
        i++
      }
      continue
    }
    mask[i] = false
    if (mode === 'sq' || mode === 'dq') {
      if (c === '\\' && mode !== 'tpl') {
        mask[i + 1] = false
        i++
      } else if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"')) {
        mode = stack.pop() ?? 'code'
      }
    } else if (mode === 'tpl') {
      if (c === '\\') {
        i++
      } else if (c === '`') {
        mode = stack.pop() ?? 'code'
      } else if (c === '$' && n === '{') {
        stack.push('tpl')
        mode = 'code'
        mask[i + 1] = false
        i++
      }
    } else if (mode === 'line') {
      if (c === '\n') mode = 'code'
    } else if (mode === 'block') {
      if (c === '*' && n === '/') {
        mask[i + 1] = false
        i++
        mode = 'code'
      }
    }
  }
  return mask
}

/** Balanced-paren spans of every `useEffect(` call, computed over the code
 *  mask (strings/comments cannot open or close a span). */
function effectSpans(src: string, mask: boolean[]): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  const needle = 'useEffect('
  let i = 0
  while ((i = src.indexOf(needle, i)) !== -1) {
    if (!mask[i]) {
      i += needle.length
      continue // a mention inside a string/comment — not an effect
    }
    const open = src.indexOf('(', i)
    let depth = 0
    let j = open
    for (; j < src.length; j++) {
      if (!mask[j]) continue
      if (src[j] === '(') depth++
      else if (src[j] === ')') {
        depth--
        if (depth === 0) break
      }
    }
    // The span limit guards a BROKEN mask (runaway scan), not big effects —
    // Phase 4-a's sprite-cache rewrite made the neural-core canvas effect a
    // legitimate ~35K chars, which tripped the old 30K cap while closing
    // correctly at its far brace. 200K accommodates real god-effects; a mask
    // bug still fails loudly here.
    if (j >= src.length || j - open > 200000) {
      throw new Error(`effect span failed to close at offset ${open} — scanner limitation hit`)
    }
    spans.push([open, j])
    i = j + 1
  }
  return spans
}

interface TimerSite {
  name: string
  isRef: boolean
  at: number
}

function findTimerSites(src: string, mask: boolean[], fn: 'setInterval' | 'requestAnimationFrame'): TimerSite[] {
  // The regex MUST carry the /g flag — a non-global exec in a while loop
  // returns the same match forever and hangs (found live in Phase 3-b lead
  // verification: the suite stalled on this exact spot).
  const re =
    fn === 'setInterval'
      ? /([A-Za-z_$][\w$]*)(\.\s*current)?\s*=\s*(?:window\s*\.\s*)?setInterval\s*\(/g
      : /([A-Za-z_$][\w$]*)\s*=\s*requestAnimationFrame\s*\(/g
  const sites: TimerSite[] = []
  let m: RegExpExecArray | null
  re.lastIndex = 0
  while ((m = re.exec(src)) !== null) {
    if (mask[m.index]) sites.push({ name: m[1], isRef: Boolean(m[2]), at: m.index })
  }
  return sites
}

function clearNames(src: string, mask: boolean[], fn: 'clearInterval' | 'cancelAnimationFrame'): Set<string> {
  const names = new Set<string>()
  const re = new RegExp(`${fn}\\(\\s*([A-Za-z_$][\\w$]*)(\\.\\s*current)?\\s*\\)`, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    if (mask[m.index]) names.add(m[1])
  }
  return names
}

const BOUNDARY_FILES = [
  'src/components/mist/consciousness/chat-panel.tsx',
  'src/components/mist/consciousness/neural-core.tsx',
  'src/components/mist/browser-window.tsx',
  'src/components/mist/settings/settings-view.tsx',
  'src/hooks/use-interval.ts',
]

describe('interval-cleanup source-of-truth scan (the four boundary surfaces + use-interval)', () => {
  for (const rel of BOUNDARY_FILES) {
    test(`${rel}: every setInterval has its clearInterval`, () => {
      const src = readFileSync(path.join(process.cwd(), rel), 'utf-8')
      const mask = codeMask(src)
      const spans = effectSpans(src, mask)
      const sites = findTimerSites(src, mask, 'setInterval')
      const cleared = clearNames(src, mask, 'clearInterval')

      if (sites.length === 0) {
        // honest reality: this surface runs on rAF/timeouts/one-shot fetches,
        // not setInterval — nothing to pin here (neural-core's rAF loop is
        // scanned in its own test below)
        expect(spans.length).toBeGreaterThanOrEqual(0)
        return
      }
      expect(cleared.size).toBeGreaterThan(0)

      for (const site of sites) {
        const span = spans.find(([a, b]) => site.at > a && site.at < b)
        if (span) {
          // effect-scoped timer: the clearInterval for THIS name must live in
          // the SAME effect (the cleanup return or the body's own disarm)
          const inside = src.slice(span[0], span[1])
          expect(
            new RegExp(`clearInterval\\(\\s*${site.name}(\\.\\s*current)?\\s*\\)`).test(inside),
            `${rel}: interval "${site.name}" at ${site.at} is cleared inside its own effect`
          ).toBe(true)
        } else {
          // ref-held timer (armed by an event handler): a clearInterval by
          // the same holder must exist somewhere in the file
          expect(
            cleared.has(site.name),
            `${rel}: ref-held interval "${site.name}" has a clearInterval by name`
          ).toBe(true)
        }
      }
      // every file that arms timers must clear at least as many names
      expect(cleared.size).toBeGreaterThanOrEqual(new Set(sites.map((s) => s.name)).size)
    })
  }

  test('neural-core: the rAF loop pairs requestAnimationFrame with cancelAnimationFrame', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/components/mist/consciousness/neural-core.tsx'), 'utf-8')
    const mask = codeMask(src)
    const sites = findTimerSites(src, mask, 'requestAnimationFrame')
    const cancels = clearNames(src, mask, 'cancelAnimationFrame')
    expect(sites.length).toBeGreaterThan(0)
    expect(cancels.size).toBeGreaterThan(0)
    for (const site of sites) {
      expect(cancels.has(site.name), `rAF handle "${site.name}" is cancelled by name`).toBe(true)
    }
  })

  test('use-neural: every listener set add has its delete (singleton guards stay paired)', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/hooks/use-neural.ts'), 'utf-8')
    const mask = codeMask(src)
    const code = (re: RegExp): number => {
      let n = 0
      let m: RegExpExecArray | null
      re.lastIndex = 0
      while ((m = re.exec(src)) !== null) if (mask[m.index]) n++
      return n
    }
    const adds = code(/Listeners\.add\(/g)
    const dels = code(/Listeners\.delete\(/g)
    expect(adds).toBeGreaterThan(0)
    expect(dels).toBe(adds)
  })
})

export { codeMask }
