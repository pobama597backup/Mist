// ============================================================================
// BROWSER PILOT — M.I.S.T. UNIFIED computer-use engine · v2.0 (Phase 2-d)
// ----------------------------------------------------------------------------
// Independent Bun mini-service · port 3030 (hardcoded, no env PORT) ·
// loopback-bound (MIST_LAN=1 widens for the PC LAN, Phase 1 rule kept).
//
// v2.0 HARDENING (mandate Phase 2, pilot line):
//   · IN-SERVICE SSRF WITH IP PIN — every navigable URL passes validateUrl
//     (mini-services/lib/url-guard): http/https only, DNS resolved once, ALL
//     addresses must be public (metadata 169.254.169.254 NEVER browsable,
//     even with MIST_LAN=1). Request interception RE-VALIDATES at the last
//     moment Playwright allows — a re-resolution answering private aborts
//     (DNS-rebinding pin). Honest residual TOCTOU documented in url-guard.
//   · BLOCKED SCHEMES ANYWHERE — file:, chrome:, chrome-extension:, about:,
//     data:, javascript:, view-source: are aborted on any frame navigation
//     AND as subresources; downloads are canceled; dialogs auto-dismissed.
//   · PER-TASK INCOGNITO — every task chain gets its OWN fresh incognito
//     context (no cookie/localStorage bleed). A task = one command chain
//     sharing a taskId: commands without one open a fresh context and return
//     its taskId; an action ERROR closes the context (the finally), an
//     explicit POST /task/close ends it, and the REAPER force-closes anything
//     older than BROWSER_TASK_TIMEOUT_MS (120s default) — /health reports
//     { contexts } so leakage is observable (tests assert it returns to 0).
//     No shared page object exists anymore.
//   · NO --no-sandbox UNLESS CONTAINER-ROOT — the flag is added only when
//     euid is 0 (Chrome refuses its own sandbox as root); as a normal user
//     the real Chromium sandbox runs (verified in this container).
//   · BEARER AUTH — /health stays open; every task endpoint requires
//     Authorization: Bearer <bridge token> (~/.mist/bridge.json — the same
//     scheme the bridge daemon uses). 401 otherwise.
//
// Endpoints (JSON in / JSON out; POST unless noted; Bearer except /health):
//   GET  /health     — liveness + { version, contexts, counters } (never launches)
//   POST /navigate   — { url, taskId? } → goto + settle (SSRF-gated BEFORE launch)
//   POST /elements   — { taskId? }      → visible interactive elements
//   POST /click      — { ref|selector|x,y, taskId? }
//   POST /type       — { text, ref?|selector?, submit?, taskId? }
//   POST /key        — { key, taskId? }
//   POST /scroll     — { direction, amount?, taskId? }
//   POST /screenshot — { taskId? }      → jpeg base64 + url/title
//   POST /extract    — { taskId? }      → body innerText
//   POST /reset      — { taskId? }      → close that task (all when absent)
//   POST /task/close — { taskId }       → explicit task end (finally-equivalent)
// ============================================================================

import { randomUUID, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import { chromium, type Browser, type BrowserContext, type Page, type ElementHandle } from 'playwright'
import { getMistSecrets } from '../lib/perimeter'
import { validateUrl } from '../lib/url-guard'

// ============================================================================
// Constants
// ============================================================================

const VERSION = '2.0.0'
const PORT = 3030
const VIEWPORT = { width: 1280, height: 800 }
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36'
const ACTION_TIMEOUT_MS = 30_000 // outer guard for any single command
const NAVIGATE_TIMEOUT_MS = 25_000
const ELEMENT_ACTION_TIMEOUT_MS = 15_000
const MAX_ELEMENTS = 60
const MAX_TEXT_CHARS = 12_000
const MAX_ELEMENT_TEXT = 60
const INTERACTIVE_SELECTOR =
  'a, button, input, select, textarea, [role="button"], [onclick]'
/** Task reaper: force-close contexts older than this (ms). Mandate default
 *  120s; env BROWSER_TASK_TIMEOUT_MS overrides (measured from context OPEN —
 *  a whole command chain, not per-command). */
const BROWSER_TASK_TIMEOUT_MS = Number(process.env.BROWSER_TASK_TIMEOUT_MS ?? 120_000) || 120_000
const REAP_SWEEP_MS = 5_000
/** Hard cap on simultaneously open task contexts — the oldest is force-closed
 *  (reaped-by-pressure) so a caller that forgets taskIds cannot pile them up. */
const MAX_OPEN_CONTEXTS = 4
const MIST_LAN = process.env.MIST_LAN === '1'
/** Schemes refused ANYWHERE in a task (navigations, clicks, subresources). */
const BLOCKED_SCHEMES = new Set([
  'file:',
  'chrome:',
  'chrome-extension:',
  'about:',
  'data:',
  'javascript:',
  'view-source:',
  'devtools:',
])

// ============================================================================
// Types
// ============================================================================

/** A visible, clickable/typed-on element, viewport-relative coordinates. */
interface ElementInfo {
  ref: number
  tag: string
  role: string
  text: string
  x: number
  y: number
  w: number
  h: number
}

interface ElementHit {
  info: ElementInfo
  handle: ElementHandle<SVGElement | HTMLElement>
}

/** One task chain: its OWN incognito context + page. */
interface TaskCtx {
  id: string
  context: BrowserContext
  page: Page
  openedAt: number
}

/** Validation error → HTTP 400/403/404. Everything else → HTTP 500. */
class ApiError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

type Action = (body: Record<string, unknown>) => Promise<Record<string, unknown>>

/** Observable security counters (exported via /health). */
const counters = {
  blocked_ssrf: 0,
  blocked_scheme: 0,
  downloads_canceled: 0,
  dialogs_dismissed: 0,
  tasks_reaped: 0,
}

// ============================================================================
// Browser lifecycle — launched lazily, relaunched transparently
// ============================================================================

let browser: Browser | null = null
let launching: Promise<void> | null = null

/** euid 0 → container-root. Chrome refuses its own sandbox when running as
 *  root, so --no-sandbox exists ONLY on that path; as a normal user the real
 *  Chromium sandbox runs (verified in this container). If the sandboxed
 *  launch ever fails in a root-only environment it fails HONESTLY — the
 *  error reaches the caller, never a silent sandbox downgrade. */
function isRoot(): boolean {
  try {
    if (typeof process.getuid === 'function') return process.getuid() === 0
  } catch {
    /* fall through to /proc */
  }
  try {
    const status = fs.readFileSync('/proc/self/status', 'utf-8')
    const m = /^Uid:\s+(\d+)/m.exec(status)
    return m !== null && m[1] === '0'
  } catch {
    return false
  }
}

/** Launch Chromium once; concurrent callers await the same in-flight launch. */
function launchBrowser(): Promise<void> {
  if (!launching) {
    launching = (async () => {
      const instance = await chromium.launch({
        headless: true,
        // NO --no-sandbox unless container-root (mandate). Non-root launches
        // with the REAL Chromium sandbox.
        args: isRoot() ? ['--no-sandbox', '--disable-dev-shm-usage'] : ['--disable-dev-shm-usage'],
      })
      browser = instance
      console.log(`[browser-pilot] chromium ${instance.version()} launched (sandboxed: ${!isRoot()})`)
    })()
      .catch((err: unknown) => {
        browser = null // failed launch → retry on next command
        throw err
      })
      .finally(() => {
        launching = null
      })
  }
  return launching
}

/** A healthy browser instance, relaunching transparently if it died. */
async function ensureBrowser(): Promise<Browser> {
  if (browser && !browser.isConnected()) {
    await browser.close().catch(() => {}) // best-effort cleanup of dead browser
    browser = null
    tasks.clear() // every task context died with the browser
  }
  if (!browser) await launchBrowser()
  return browser!
}

// ============================================================================
// Task contexts — per-task incognito, finally-close, reaper
// ============================================================================

const tasks = new Map<string, TaskCtx>()

/** Every page born in a task context (incl. popups) gets the download/dialog
 *  handlers; the CONTEXT-level route installs the SSRF pin for everything. */
async function wireContext(context: BrowserContext): Promise<void> {
  context.on('page', (page) => wirePage(page))
  await context.route('**/*', async (route) => {
    const req = route.request()
    let u: URL
    try {
      u = new URL(req.url())
    } catch {
      counters.blocked_scheme++
      return route.abort('failed')
    }
    // frame NAVIGATION must be http/https — file:/chrome:/data: targets from
    // clicks, JS redirects or iframes abort right here
    if (req.isNavigationRequest() && u.protocol !== 'http:' && u.protocol !== 'https:') {
      counters.blocked_scheme++
      return route.abort('blockedbyclient')
    }
    if (BLOCKED_SCHEMES.has(u.protocol)) {
      counters.blocked_scheme++
      return route.abort('blockedbyclient')
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      // blob:, chromium-internal and friends are not in the mandate's block
      // set — subresource traffic on them stays flowing
      return route.continue()
    }
    // the PIN: re-resolve + re-validate at the last moment before the request
    // leaves the browser. A rebinding answer (private/metadata) aborts here.
    const verdict = await validateUrl(req.url(), { mistLan: MIST_LAN })
    if (!verdict.ok) {
      counters.blocked_ssrf++
      return route.abort('blockedbyclient')
    }
    return route.continue()
  })
}

function wirePage(page: Page): void {
  page.on('download', (download) => {
    counters.downloads_canceled++
    void download.cancel().catch(() => {})
  })
  page.on('dialog', (dialog) => {
    counters.dialogs_dismissed++
    void dialog.dismiss().catch(() => {})
  })
}

async function closeTask(id: string): Promise<number> {
  const task = tasks.get(id)
  if (!task) return 0
  tasks.delete(id)
  await task.context.close().catch(() => {})
  return 1
}

async function closeAllTasks(): Promise<number> {
  let closed = 0
  for (const id of [...tasks.keys()]) closed += await closeTask(id)
  return closed
}

/** The task for a command: reuse the chain's live context, or open a FRESH
 *  incognito one (missing/stale/reaped taskId → new context + new id, which
 *  the response returns so the caller can chain on it). */
async function ensureTask(taskId: string | undefined): Promise<TaskCtx> {
  if (taskId) {
    const known = tasks.get(taskId)
    if (known && !known.page.isClosed()) return known
  }
  const instance = await ensureBrowser()
  if (tasks.size >= MAX_OPEN_CONTEXTS) {
    const oldest = [...tasks.values()].sort((a, b) => a.openedAt - b.openedAt)[0]
    if (oldest) {
      counters.tasks_reaped++
      await closeTask(oldest.id).catch(() => {})
    }
  }
  // each task: its OWN incognito context — no cookie/localStorage bleed
  const context = await instance.newContext({ viewport: VIEWPORT, userAgent: USER_AGENT })
  await wireContext(context)
  const page = await context.newPage()
  const task: TaskCtx = { id: `t-${randomUUID()}`, context, page, openedAt: Date.now() }
  tasks.set(task.id, task)
  return task
}

/** Run one command inside its task. The FINALLY: a FAILED command closes the
 *  task context (a dead chain never leaks); success leaves it open for the
 *  next command of the chain — the reaper is the closer of record. */
async function runTask<T extends Record<string, unknown>>(
  body: Record<string, unknown>,
  fn: (task: TaskCtx) => Promise<T>,
): Promise<T & { taskId: string }> {
  const task = await ensureTask(typeof body.taskId === 'string' && body.taskId ? body.taskId : undefined)
  try {
    const out = await fn(task)
    return { ...out, taskId: task.id }
  } catch (err) {
    await closeTask(task.id).catch(() => {})
    throw err
  }
}

// The REAPER — force-close contexts older than BROWSER_TASK_TIMEOUT_MS.
const reaper = setInterval(() => {
  const now = Date.now()
  for (const task of [...tasks.values()]) {
    if (now - task.openedAt > BROWSER_TASK_TIMEOUT_MS) {
      counters.tasks_reaped++
      void closeTask(task.id).catch(() => {})
    }
  }
}, REAP_SWEEP_MS)
reaper.unref?.()

// ============================================================================
// Async mutex — commands execute strictly one at a time
// ============================================================================

let chain: Promise<unknown> = Promise.resolve()

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task) // run regardless of previous outcome
  chain = run.then(
    () => {},
    () => {},
  ) // swallow so the chain never dead-ends
  return run
}

// ============================================================================
// Timeout guard — an action may never hang the queue forever
// ============================================================================

function withTimeout<T>(promise: Promise<T>, ms: number = ACTION_TIMEOUT_MS): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`action timed out after ${ms}ms`)),
        ms,
      )
      timer.unref?.()
    }),
  ])
}

// ============================================================================
// Element enumeration (shared by /elements and ref-based targeting)
// ============================================================================

async function enumerateInteractive(currentPage: Page): Promise<ElementHit[]> {
  const handles = await currentPage.$$(INTERACTIVE_SELECTOR)
  const hits: ElementHit[] = []
  for (const handle of handles) {
    if (hits.length >= MAX_ELEMENTS) break
    try {
      if (!(await handle.isVisible())) continue
      const box = await handle.boundingBox()
      if (!box || box.width < 2 || box.height < 2) continue // meaningful size only
      const meta = await handle.evaluate((el) => {
        const html = el as HTMLElement
        const tag = html.tagName.toLowerCase()
        const explicitRole = html.getAttribute('role')
        let role = explicitRole ?? ''
        if (!role) {
          if (tag === 'a') role = 'link'
          else if (tag === 'button') role = 'button'
          else if (tag === 'select') role = 'combobox'
          else if (tag === 'textarea') role = 'textbox'
          else if (tag === 'input') {
            const type = (html as HTMLInputElement).type || 'text'
            role =
              type === 'checkbox'
                ? 'checkbox'
                : type === 'radio'
                  ? 'radio'
                  : type === 'button' || type === 'submit' || type === 'reset'
                    ? 'button'
                    : 'textbox'
          } else role = tag
        }
        let text = (html.innerText ?? '').trim()
        if (!text) {
          const value = (html as HTMLInputElement).value
          if (typeof value === 'string' && value.trim()) text = value.trim()
        }
        if (!text) {
          text =
            html.getAttribute('aria-label') ||
            html.getAttribute('placeholder') ||
            html.getAttribute('title') ||
            ''
        }
        return { tag, role, text }
      })
      hits.push({
        info: {
          ref: hits.length, // sequential index over *included* elements
          tag: meta.tag,
          role: meta.role,
          text: meta.text.replace(/\s+/g, ' ').trim().slice(0, MAX_ELEMENT_TEXT),
          x: Math.round(box.x),
          y: Math.round(box.y),
          w: Math.round(box.width),
          h: Math.round(box.height),
        },
        handle,
      })
    } catch {
      // Element detached mid-enumeration (SPA re-render) — skip it.
    }
  }
  return hits
}

// ============================================================================
// Helpers
// ============================================================================

/** Validate a ref (element index) passed in a body. */
function requireRef(body: Record<string, unknown>): number {
  const ref = body.ref
  if (typeof ref !== 'number' || !Number.isInteger(ref) || ref < 0) {
    throw new ApiError('"ref" must be a non-negative integer')
  }
  return ref
}

/** Resolve a ref against a FRESH enumeration (page may have changed since /elements). */
async function resolveRef(
  currentPage: Page,
  ref: number,
): Promise<{ hit: ElementHit; total: number }> {
  const hits = await enumerateInteractive(currentPage)
  if (ref >= hits.length) {
    throw new ApiError(`ref ${ref} out of range (page currently exposes ${hits.length} interactive elements)`)
  }
  return { hit: hits[ref], total: hits.length }
}

function describeHit(hit: ElementHit): string {
  const { tag, text } = hit.info
  return `<${tag}>${text ? ` "${text}"` : ''}`
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const raw = await req.text()
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {} // malformed JSON → treat as empty body; actions validate their inputs
  }
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/** Bearer gate — the same token the bridge daemon honors (~/.mist/bridge.json
 *  via the perimeter helper). Timing-safe, fail-closed. */
function isAuthorized(req: Request): boolean {
  const header = req.headers.get('authorization') ?? ''
  if (!header.startsWith('Bearer ')) return false
  const token = header.slice(7).trim()
  if (!token) return false
  const expected = getMistSecrets().bridgeToken
  try {
    const a = Buffer.from(token)
    const b = Buffer.from(expected)
    return a.length === b.length && timingSafeEqual(a, b)
  } catch {
    return false
  }
}

// ============================================================================
// Actions — each runs inside its task; the dispatcher adds ok/taskId
// ============================================================================

/** POST /navigate { url, taskId? } — the in-service SSRF gate runs BEFORE any
 *  context or browser exists; refused targets never touch Chromium. */
async function actNavigate(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const raw = typeof body.url === 'string' ? body.url : ''
  if (!raw.trim()) throw new ApiError('"url" is required')
  const verdict = await validateUrl(raw, { mistLan: MIST_LAN })
  if (!verdict.ok) throw new ApiError(verdict.reason ?? 'refused: URL not browsable', 403)
  return runTask(body, async (task) => {
    await task.page.goto(verdict.url!, { waitUntil: 'domcontentloaded', timeout: NAVIGATE_TIMEOUT_MS })
    await task.page.waitForTimeout(800) // settle: late scripts / client redirects
    return { url: task.page.url(), title: await task.page.title() }
  })
}

/** POST /elements { taskId? } */
async function actElements(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  return runTask(body, async (task) => {
    const hits = await enumerateInteractive(task.page)
    return {
      url: task.page.url(),
      title: await task.page.title(),
      elements: hits.map(({ info }) => info),
    }
  })
}

/** POST /click { ref?, selector?, x?, y?, taskId? } */
async function actClick(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  return runTask(body, async (task) => {
    const currentPage = task.page
    const hasRef = body.ref !== undefined
    const selector = typeof body.selector === 'string' ? body.selector.trim() : ''
    const hasCoords = typeof body.x === 'number' && typeof body.y === 'number'

    let clicked: string
    if (hasRef) {
      const ref = requireRef(body)
      const { hit } = await resolveRef(currentPage, ref)
      await hit.handle.click({ timeout: ELEMENT_ACTION_TIMEOUT_MS })
      clicked = `ref ${ref} ${describeHit(hit)}`
    } else if (selector) {
      await currentPage.click(selector, { timeout: ELEMENT_ACTION_TIMEOUT_MS })
      clicked = `selector ${JSON.stringify(selector)}`
    } else if (hasCoords) {
      const x = Math.round(body.x as number)
      const y = Math.round(body.y as number)
      await currentPage.mouse.click(x, y)
      clicked = `coordinates (${x}, ${y})`
    } else {
      throw new ApiError('no click target — provide "ref", "selector", or "x" + "y"')
    }
    await currentPage.waitForTimeout(600) // settle after click
    return { clicked, url: currentPage.url(), title: await currentPage.title() }
  })
}

/** POST /type { text, ref?, selector?, submit?, taskId? } */
async function actType(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (typeof body.text !== 'string') throw new ApiError('"text" (string) is required')
  return runTask(body, async (task) => {
    const currentPage = task.page
    const hasRef = body.ref !== undefined
    const selector = typeof body.selector === 'string' ? body.selector.trim() : ''

    if (hasRef) {
      const ref = requireRef(body)
      const { hit } = await resolveRef(currentPage, ref)
      await hit.handle.click({ timeout: ELEMENT_ACTION_TIMEOUT_MS }) // focus the target
    } else if (selector) {
      await currentPage.click(selector, { timeout: ELEMENT_ACTION_TIMEOUT_MS })
    }
    // No ref/selector → type into whatever currently has focus.
    await currentPage.keyboard.type(body.text as string, { delay: 15 })
    if (body.submit === true) {
      await currentPage.keyboard.press('Enter')
      await currentPage.waitForTimeout(900) // let navigation/search land
    }
    return { url: currentPage.url(), title: await currentPage.title() }
  })
}

/** POST /key { key, taskId? } */
async function actKey(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (typeof body.key !== 'string' || !body.key.trim()) {
    throw new ApiError('"key" is required (e.g. "Enter", "Control+a")')
  }
  return runTask(body, async (task) => {
    await task.page.keyboard.press((body.key as string).trim())
    await task.page.waitForTimeout(400)
    return {}
  })
}

/** POST /scroll { direction, amount?, taskId? } */
async function actScroll(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const direction = body.direction
  if (direction !== 'up' && direction !== 'down') {
    throw new ApiError('"direction" must be "up" or "down"')
  }
  const amount =
    typeof body.amount === 'number' && Number.isFinite(body.amount) && body.amount > 0
      ? Math.min(Math.round(body.amount), 10_000)
      : 600
  return runTask(body, async (task) => {
    await task.page.mouse.wheel(0, direction === 'up' ? -amount : amount)
    await task.page.waitForTimeout(400)
    return {}
  })
}

/** POST /screenshot { taskId? } → jpeg base64 + viewport size */
async function actScreenshot(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  return runTask(body, async (task) => {
    const shot = await task.page.screenshot({ type: 'jpeg', quality: 70 })
    const size = task.page.viewportSize() ?? VIEWPORT
    return {
      image: Buffer.from(shot).toString('base64'),
      url: task.page.url(),
      title: await task.page.title(),
      width: size.width,
      height: size.height,
    }
  })
}

/** POST /extract { taskId? } → readable page text */
async function actExtract(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  return runTask(body, async (task) => {
    const raw = await task.page.evaluate(() => (document.body?.innerText ?? '') as string)
    const text = raw
      .replace(/\n{3,}/g, '\n\n') // collapse 3+ newlines to 2
      .trim()
      .slice(0, MAX_TEXT_CHARS)
    return { url: task.page.url(), title: await task.page.title(), text }
  })
}

/** POST /reset { taskId? } → close that task's context (all when absent). */
async function actReset(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const closed =
    typeof body.taskId === 'string' && body.taskId ? await closeTask(body.taskId) : await closeAllTasks()
  return { closed }
}

/** POST /task/close { taskId } → explicit task end (idempotent). */
async function actTaskClose(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const closed = typeof body.taskId === 'string' && body.taskId ? await closeTask(body.taskId) : 0
  return { closed }
}

// ============================================================================
// Route table
// ============================================================================

const ROUTES: Record<string, Action> = {
  '/navigate': actNavigate,
  '/elements': actElements,
  '/click': actClick,
  '/type': actType,
  '/key': actKey,
  '/scroll': actScroll,
  '/screenshot': actScreenshot,
  '/extract': actExtract,
  '/reset': actReset,
  '/task/close': actTaskClose,
}

// ============================================================================
// Health — read-only snapshot (open, no Bearer; never launches the browser)
// ============================================================================

async function healthPayload(): Promise<Record<string, unknown>> {
  return {
    status: 'ok',
    service: 'browser-pilot',
    version: VERSION,
    contexts: tasks.size,
    browser_up: !!(browser && browser.isConnected()),
    task_timeout_ms: BROWSER_TASK_TIMEOUT_MS,
    mist_lan: MIST_LAN,
    counters: { ...counters },
  }
}

// ============================================================================
// Request pipeline
// ============================================================================

async function handleRequest(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url)

  if (req.method === 'GET' && pathname === '/health') {
    return json(await healthPayload())
  }

  // every task endpoint: the machine Bearer (mirrors the bridge daemon)
  if (!isAuthorized(req)) {
    return json({ ok: false, error: 'unauthorized — browser-pilot task endpoints require the machine Bearer token' }, 401)
  }

  const action = ROUTES[pathname]
  if (!action) return json({ ok: false, error: `unknown route: ${req.method} ${pathname}` }, 404)
  if (req.method !== 'POST') return json({ ok: false, error: `${pathname} requires POST` }, 405)

  const body = await readBody(req)
  try {
    // Serialize (never interleave page actions) + time-box every command.
    const payload = await withTimeout(serialize(() => action(body)))
    return json({ ok: true, ...payload })
  } catch (err) {
    if (err instanceof ApiError) return json({ ok: false, error: err.message }, err.status)
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[browser-pilot] ${req.method} ${pathname} failed: ${message}`)
    return json({ ok: false, error: message }, 500)
  }
}

// ============================================================================
// HTTP server (plain Bun — no framework; loopback bind is the Phase 1 gate)
// ============================================================================

const server = Bun.serve({
  hostname: MIST_LAN ? '0.0.0.0' : '127.0.0.1', // Phase 1: loopback-only (MIST_LAN=1 widens for the PC LAN)
  port: PORT,
  fetch(req) {
    return handleRequest(req).catch((err: unknown) => {
      // Last-resort safety net — the server must never crash.
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[browser-pilot] unhandled error: ${message}`)
      return json({ ok: false, error: message }, 500)
    })
  },
})

// Graceful shutdown — close every task context + the browser with the process.
async function shutdown() {
  console.log('[browser-pilot] shutting down…')
  await closeAllTasks().catch(() => {})
  await browser?.close().catch(() => {})
  server.stop(true)
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

console.log(`[browser-pilot] v${VERSION} listening on http://${server.hostname}:${server.port}`)
console.log('[browser-pilot] per-task incognito contexts; Bearer-gated task endpoints; /health is open')
