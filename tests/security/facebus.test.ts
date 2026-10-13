// Phase 6-b · FACEBUS tests — the postMessage face-bus source-of-truth
// scan (the tabboundary/defang pattern: pin invariants into the source
// with regexes; no browser needed, pure fs + regex, fast + deterministic).
//
//   SANDBOX   face-stage.tsx renders the face frames WITH
//             sandbox="allow-scripts" and WITHOUT allow-same-origin —
//             the whole point of the 6-b migration (the frames become
//             opaque-origin documents that cannot touch the parent DOM,
//             cookies or storage).
//   NO-PARENT Every file under public/av is scanned (script blocks in the
//             HTML faces, whole core.js): no window.parent.__mistBus, no
//             parent.document, no window.top. — and every window.parent
//             member access must be postMessage, nothing else.
//   GATES     face-bus.ts validates inbound messages: the __mistFace
//             marker constant, the event.source allowlist (faceFrames),
//             the origin gate ("null" for our sandboxed frames, our own
//             origin for an unsandboxed embed, anything else foreign) —
//             and face-stage actually feeds the registry
//             (attach/detachFaceFrame) or the source gate starves.
//   TARGETS   targetOrigin is never '*': every postMessage( argument
//             span in face-bus.ts, core.js and the visage face is
//             wildcard-free; the iframe→parent window.postMessages carry
//             the derived strict origin (new URL("/", location.href).origin),
//             and the parent→iframe direction rides private MessagePorts
//             (port.postMessage has no targetOrigin at all — an opaque
//             origin can never be addressed by a literal targetOrigin).
//   MARKER    the protocol marker literal matches on BOTH sides
//             (face-bus.ts FACE_MARKER === core.js MIST.marker === the
//             visage's MIST_MARKER) — a silent rename on one side would
//             kill the bus with no error anywhere; this test is the tripwire.
//   RAIN      the rain face's VT323 font + face portrait stay embedded as
//             data: URIs (sandbox consequence pins: a remote @font-face is
//             a CORS-mode fetch the opaque origin cannot make without ACAO
//             headers, and a url()-loaded portrait would taint the canvas
//             and throw inside the getImageData mask pipeline).
//
// Honest limits: this scanner is AST-lite (no type checking, no
// cross-file flow, HTML scanned at <script> granularity); it pins the
// CONTRACT, not execution. Regex literals are not masked — none of the
// scanned scripts carry parens inside a regex literal (span sanity checks
// fail loudly if that ever changes).
//
// Run: bun test tests/security/facebus.test.ts
import { test, expect, describe } from 'bun:test'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'

const ROOT = process.cwd()
const read = (rel: string): string => readFileSync(path.join(ROOT, rel), 'utf-8')

const FACE_STAGE = 'src/components/mist/consciousness/face-stage.tsx'
const FACE_BUS = 'src/lib/face-bus.ts'
const CORE = 'public/av/core.js'
const VISAGE = 'public/av/faces/visage/index.html'
const RAIN = 'public/av/faces/rain/index.html'

// ---------------------------------------------------------------- helpers

/** Every file under public/av, recursively (the face pages + shared core). */
function walkAv(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`
    if (entry.isDirectory()) out.push(...walkAv(rel))
    else out.push(rel)
  }
  return out
}

/** The executable JS of a file: inline <script> blocks for HTML faces,
 *  the whole file for .js. Scanned at script granularity because the ban
 *  patterns are about code (the faces wire everything in JS — no inline
 *  HTML event handlers exist in public/av, pinned by the last test). */
function scriptsOf(rel: string): string[] {
  const src = read(rel)
  if (rel.endsWith('.html')) {
    const blocks = [...src.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(
      (m) => m[1] as string
    )
    expect(
      blocks.length,
      `${rel}: expected at least one <script> block (scanner blind spot?)`
    ).toBeGreaterThan(0)
    // The src="../../core.js" blocks contribute an empty body — fine.
    return blocks
  }
  return [src]
}

/** A string/comment/template-aware "is this a real code char" mask over one
 *  script block (the tabboundary codeMask, trimmed to what these files
 *  carry; regex literals are NOT handled — see the honest-limits note). */
function codeMask(src: string): boolean[] {
  const mask = new Array<boolean>(src.length).fill(true)
  type Mode = 'code' | 'sq' | 'dq' | 'tpl' | 'line' | 'block'
  const stack: Mode[] = []
  let mode: Mode = 'code'
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const n = src[i + 1]
    if (mode === 'code') {
      if (c === "'") {
        mode = 'sq'
        stack.push('code')
        mask[i] = false
      } else if (c === '"') {
        mode = 'dq'
        stack.push('code')
        mask[i] = false
      } else if (c === '`') {
        mode = 'tpl'
        stack.push('code')
        mask[i] = false
      } else if (c === '}' && stack.length > 0) {
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
      if (c === '\\') {
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
        mask[i] = mask[i + 1] = false
        i++
      }
    } else if (mode === 'line') {
      if (c === '\n') mode = 'code'
    } else if (mode === 'block') {
      if (c === '*' && n === '/') {
        mask[i] = mask[i + 1] = false
        i++
        mode = 'code'
      }
    }
  }
  return mask
}

/** Balanced-paren argument spans of every postMessage( call, computed over
 *  the code mask (strings/comments cannot open or close a span). */
function postMessageSpans(src: string, mask: boolean[]): string[] {
  const spans: string[] = []
  const needle = 'postMessage('
  let i = 0
  while ((i = src.indexOf(needle, i)) !== -1) {
    if (mask[i]) {
      const open = i + needle.length - 1
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
      if (j >= src.length || j - open > 10000) {
        throw new Error(`postMessage span failed to close at offset ${open} — scanner limitation hit`)
      }
      spans.push(src.slice(open + 1, j))
    }
    i += needle.length
  }
  return spans
}

// ------------------------------------------------- 1 · the true sandbox

describe('face-stage renders the face frames fully sandboxed', () => {
  test('iframe JSX: sandbox="allow-scripts" present, allow-same-origin absent (whole file)', () => {
    const src = read(FACE_STAGE)
    const start = src.indexOf('<iframe')
    const end = src.indexOf('/>', start)
    expect(start, `${FACE_STAGE}: an <iframe element must exist`).toBeGreaterThanOrEqual(0)
    expect(end, `${FACE_STAGE}: the iframe element must close`).toBeGreaterThan(start)
    const block = src.slice(start, end + 2)
    expect(
      /sandbox\s*=\s*"allow-scripts"/.test(block),
      `${FACE_STAGE}: the face iframe must carry sandbox="allow-scripts" — the Phase 6-b mandate. ` +
        `Without it the faces are not opaque-origin documents and can reach the parent DOM.`
    ).toBe(true)
    expect(
      !block.includes('allow-same-origin'),
      `${FACE_STAGE}: allow-same-origin must NEVER appear on the face iframe — it would ` +
        `defeat the entire sandbox (the frames would read parent DOM/cookies/storage again).`
    ).toBe(true)
    expect(
      !src.includes('allow-same-origin'),
      `${FACE_STAGE}: allow-same-origin must not appear anywhere in the file`
    ).toBe(true)
    // behavior-preservation pins (these protected the frames before 6-b)
    expect(block).toContain('referrerPolicy="no-referrer"')
    expect(block).toContain('allowFullScreen')
    expect(block).toContain('aria-label={meta.title}')
    expect(block).toContain('allow="microphone"')
  })
})

// ------------------------------------------ 2 · no direct parent access

describe('public/av contains no direct parent DOM access', () => {
  const AV_FILES = walkAv('public/av')

  test('the walk found the shared core and all face pages (scanner sanity)', () => {
    expect(AV_FILES).toContain(CORE)
    expect(AV_FILES).toContain(VISAGE)
    expect(AV_FILES.filter((f) => f.includes('/faces/')).length).toBeGreaterThanOrEqual(5)
  })

  for (const rel of AV_FILES) {
    test(`${rel}: no window.parent.__mistBus / parent.document / window.top. — only postMessage`, () => {
      const scripts = scriptsOf(rel)
      for (const js of scripts) {
        const mask = codeMask(js)
        const at = (re: RegExp): number => {
          let n = 0
          let m: RegExpExecArray | null
          re.lastIndex = 0
          while ((m = re.exec(js)) !== null) if (mask[m.index]) n++
          return n
        }
        expect(
          at(/window\s*\.\s*parent\s*\.\s*__mistBus/g),
          `${rel}: window.parent.__mistBus is gone — the bus rides postMessage now (Phase 6-b). ` +
            `A same-origin parent read would also crash under the sandbox attribute.`
        ).toBe(0)
        expect(
          at(/\bparent\s*\.\s*document\b/g),
          `${rel}: parent.document access is forbidden — sandboxed frames must never touch the parent DOM`
        ).toBe(0)
        expect(
          at(/window\s*\.\s*top\s*\./g),
          `${rel}: window.top.* access is forbidden — no reaching above the frame`
        ).toBe(0)
        // allowlist: any window.parent.<member> read must be postMessage
        const member = /window\s*\.\s*parent\s*\.\s*([A-Za-z_$][\w$]*)/g
        let m: RegExpExecArray | null
        member.lastIndex = 0
        while ((m = member.exec(js)) !== null) {
          if (!mask[m.index]) continue
          expect(
            m[1],
            `${rel}: window.parent.${m[1]} is not allowed — the ONLY member these frames may ` +
              `touch on window.parent is postMessage (identity checks like ` +
              `"window.parent === window" are fine and not member reads)`
          ).toBe('postMessage')
        }
      }
    })
  }

  test('the transports actually exist (positive control — the bans above must not pass vacuously)', () => {
    const core = read(CORE)
    const visage = read(VISAGE)
    expect(
      /window\s*\.\s*parent\s*\.\s*postMessage\s*\(/.test(core),
      `${CORE}: the MIST embed transport must talk to the parent via window.parent.postMessage`
    ).toBe(true)
    expect(
      /window\s*\.\s*parent\s*\.\s*postMessage\s*\(/.test(visage),
      `${VISAGE}: the visage transport must talk to the parent via window.parent.postMessage`
    ).toBe(true)
  })
})

// ------------------------------------------- 3 · inbound message gates

describe('face-bus validates incoming messages (source + origin + marker)', () => {
  test('marker constant, source allowlist, origin gate all present in the handler path', () => {
    const bus = read(FACE_BUS)
    expect(
      /const FACE_MARKER = '__mistFace'/.test(bus),
      `${FACE_BUS}: the protocol marker constant must be defined as the '__mistFace' literal ` +
        `(the protocol marker both sides must agree on)`
    ).toBe(true)
    expect(
      /m\[FACE_MARKER\] !== true/.test(bus),
      `${FACE_BUS}: inbound data must be gated on the FACE_MARKER check — never trust the payload shape blindly`
    ).toBe(true)
    expect(
      /faceFrames\.has\(/.test(bus),
      `${FACE_BUS}: event.source must be validated against the faceFrames allowlist ` +
        `(only messages from the face-stage-attached contentWindows may be considered)`
    ).toBe(true)
    expect(
      /ev\.origin !== 'null' && ev\.origin !== window\.location\.origin/.test(bus),
      `${FACE_BUS}: the origin gate must run — our sandboxed faces serialize as the opaque ` +
        `origin 'null', an unsandboxed same-origin embed sends our own origin, anything else is foreign`
    ).toBe(true)
    expect(
      /window\.addEventListener\('message', onFaceFrameMessage\)/.test(bus),
      `${FACE_BUS}: the 'message' listener must be installed on the parent window`
    ).toBe(true)
  })

  test('face-stage feeds the registry (attach + detach), or the source gate starves', () => {
    const stage = read(FACE_STAGE)
    expect(
      /attachFaceFrame\(/.test(stage),
      `${FACE_STAGE}: face-stage must attach its iframe's contentWindow to the face bus — ` +
        `without the attach the bridge's source allowlist rejects every hello and the faces sit dead`
    ).toBe(true)
    expect(
      /detachFaceFrame\(/.test(stage),
      `${FACE_STAGE}: face-stage must detach on unmount (balanced listener/port hygiene)`
    ).toBe(true)
  })
})

// --------------------------------------- 4 · targetOrigin is never '*'

describe("targetOrigin is never a wildcard — strict origin in, private port back", () => {
  const SCAN = [FACE_BUS, CORE, VISAGE]

  for (const rel of SCAN) {
    test(`${rel}: every postMessage( argument span is wildcard-free`, () => {
      for (const js of scriptsOf(rel)) {
        const mask = codeMask(js)
        for (const span of postMessageSpans(js, mask)) {
          expect(
            !/(^|[^.\w$])['"]\*['"]/.test(span),
            `${rel}: a postMessage call carries the '*' wildcard targetOrigin: "${span.slice(0, 120)}…" — ` +
              `wildcards are forbidden; the iframe→parent direction uses the strict derived origin and ` +
              `the parent→iframe direction rides private MessagePorts`
          ).toBe(true)
        }
      }
    })
  }

  test('core.js + visage: window.parent.postMessages target the derived strict origin', () => {
    for (const rel of [CORE, VISAGE]) {
      const js = scriptsOf(rel).join('\n')
      const mask = codeMask(js)
      expect(
        /new URL\("\/", location\.href\)\.origin/.test(js),
        `${rel}: the transport must derive the parent's origin from its own URL ` +
          `(new URL("/", location.href).origin — location.origin reads "null" under the sandbox)`
      ).toBe(true)
      // every window.parent.postMessage span carries the strict origin variable
      const strictVar = rel === CORE ? 'MIST.origin' : 'mistOrigin'
      const needle = 'window.parent.postMessage'
      let i = 0
      let calls = 0
      while ((i = js.indexOf(needle, i)) !== -1) {
        if (mask[i]) {
          calls++
          const open = js.indexOf('(', i)
          let depth = 0
          let j = open
          for (; j < js.length; j++) {
            if (!mask[j]) continue
            if (js[j] === '(') depth++
            else if (js[j] === ')') {
              depth--
              if (depth === 0) break
            }
          }
          const span = js.slice(open + 1, j)
          expect(
            span.includes(strictVar),
            `${rel}: window.parent.postMessage must pass ${strictVar} as targetOrigin ` +
              `(strict, never '*'): got "${span.slice(0, 120)}…"`
          ).toBe(true)
        }
        i += needle.length
      }
      expect(calls, `${rel}: expected window.parent.postMessage call sites`).toBeGreaterThan(0)
    }
  })

  test('face-bus: parent→frame traffic rides private MessagePorts (no window.postMessage target needed)', () => {
    const bus = read(FACE_BUS)
    expect(
      /port\.postMessage\(/.test(bus),
      `${FACE_BUS}: the bridge must answer the frames over their private MessagePorts — ` +
        `an opaque-origin frame cannot be addressed by window.postMessage with a literal targetOrigin`
    ).toBe(true)
    expect(
      !/window\.postMessage\s*\(/.test(bus),
      `${FACE_BUS}: the bridge must not call window.postMessage itself (the wildcard-free rule)`
    ).toBe(true)
  })
})

// --------------------------------------------- 5 · protocol marker parity

describe('the protocol marker matches on both sides of the bus', () => {
  test("face-bus FACE_MARKER === core.js MIST.marker === visage MIST_MARKER === '__mistFace'", () => {
    const bus = read(FACE_BUS)
    const core = read(CORE)
    const visage = read(VISAGE)

    const busMarker = bus.match(/const FACE_MARKER = '([^']+)'/)
    const coreMarker = core.match(/marker:\s*"([^"]+)"/)
    const visageMarker = visage.match(/const MIST_MARKER = "([^"]+)"/)

    expect(busMarker, `${FACE_BUS}: FACE_MARKER constant not found`).toBeTruthy()
    expect(coreMarker, `${CORE}: the MIST marker literal not found`).toBeTruthy()
    expect(visageMarker, `${VISAGE}: the MIST_MARKER constant not found`).toBeTruthy()

    const markers = [busMarker![1], coreMarker![1], visageMarker![1]]
    for (const m of markers) {
      expect(
        m,
        `the __mistFace protocol marker must be exactly '__mistFace' (got '${m}') — both sides ` +
          `of the bus AND this test agree on the literal`
      ).toBe('__mistFace')
    }
  })
})

// ------------------------------- 6 · rain sandbox-consequence regressions

describe('rain: the font + portrait stay embedded (sandbox CORS/taint consequences)', () => {
  test('no remote asset URLs remain in the rain face — data: URIs only', () => {
    const src = read(RAIN)
    for (const js of scriptsOf(RAIN)) {
      const mask = codeMask(js)
      let m: RegExpExecArray | null
      const re = /(["'])\.\.\/\.\.\/assets\//g
      re.lastIndex = 0
      while ((m = re.exec(js)) !== null) {
        if (!mask[m.index]) continue
        expect(
          false,
          `${RAIN}: remote asset reference "${m[0]}…" in code — under the opaque-origin sandbox a ` +
            `remote @font-face is a CORS fetch that fails without ACAO, and a url() portrait taints ` +
            `the canvas (getImageData throws). Assets must stay embedded as data: URIs.`
        ).toBe(true)
      }
    }
    expect(
      /@font-face\{font-family:"VT323";src:url\(data:font\/ttf;base64,/.test(src),
      `${RAIN}: the VT323 font must stay embedded as a data: URI (remote font loads are CORS-mode ` +
        `fetches; the sandboxed frame cannot make them against ACAO-less static assets)`
    ).toBe(true)
    expect(
      /img\.src="data:image\/png;base64,/.test(src),
      `${RAIN}: the face portrait must stay embedded as a data: URI (a url()-loaded image taints ` +
        `the canvas under the sandbox and breaks the getImageData mask pipeline)`
    ).toBe(true)
  })

  test('public/av HTML carries no inline event handlers (script-granularity scan is complete)', () => {
    for (const rel of walkAv('public/av').filter((f) => f.endsWith('.html'))) {
      const src = read(rel)
      const handler = /<[^>]*\son[a-z]+\s*=\s*["'][^"']*window\.parent/s
      expect(
        !handler.test(src),
        `${rel}: inline event handlers reaching window.parent would bypass the script-block scan — ` +
        `forbidden (and no face has any)`
      ).toBe(true)
    }
  })
})
