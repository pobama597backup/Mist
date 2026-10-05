// ============================================================================
// BROWSER PILOT — M.I.S.T. UNIFIED computer-use engine (Task ID 7)
// ----------------------------------------------------------------------------
// Independent Bun mini-service · port 3030 (hardcoded, no env PORT).
//
// One shared headless Chromium + one shared page (1280x800, desktop UA),
// lazily launched on the first command. All commands run through an async
// mutex so page actions never interleave. Every action is time-boxed (30s
// outer guard) and every failure is returned as JSON { ok: false, error } —
// the server itself never crashes. A crashed browser/page is relaunched
// transparently by the next command.
//
// Endpoints (JSON in / JSON out):
//   GET  /health     — liveness + current page state (never launches browser)
//   POST /navigate   — { url }                        → goto + settle
//   POST /elements   — {}                             → visible interactive elements
//   POST /click      — { ref | selector | x,y }       → click + settle
//   POST /type       — { text, ref? | selector?, submit? }
//   POST /key        — { key }                        → keyboard.press
//   POST /scroll     — { direction, amount? }         → mouse.wheel
//   POST /screenshot — {}                             → jpeg (base64) + url/title
//   POST /extract    — {}                             → body innerText
//   POST /reset      — {}                             → close page, fresh one
// ============================================================================

import { chromium, type Browser, type Page, type ElementHandle } from 'playwright';

// ============================================================================
// Constants
// ============================================================================

const PORT = 3030;
const VIEWPORT = { width: 1280, height: 800 };
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const ACTION_TIMEOUT_MS = 30_000; // outer guard for any single command
const NAVIGATE_TIMEOUT_MS = 25_000;
const ELEMENT_ACTION_TIMEOUT_MS = 15_000; // per-element click()/boundingBox() budget
const MAX_ELEMENTS = 60;
const MAX_TEXT_CHARS = 12_000;
const MAX_ELEMENT_TEXT = 60;
const INTERACTIVE_SELECTOR =
  'a, button, input, select, textarea, [role="button"], [onclick]';

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
};

// ============================================================================
// Types
// ============================================================================

/** A visible, clickable/typed-on element, viewport-relative coordinates. */
interface ElementInfo {
  ref: number;
  tag: string;
  role: string;
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ElementHit {
  info: ElementInfo;
  handle: ElementHandle<SVGElement | HTMLElement>;
}

/** Validation error → HTTP 400. Everything else → HTTP 500. */
class ApiError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

type Action = (body: Record<string, unknown>) => Promise<Record<string, unknown>>;

// ============================================================================
// Shared browser state — lazily launched, transparently relaunched
// ============================================================================

let browser: Browser | null = null;
let page: Page | null = null;
let launching: Promise<void> | null = null;

/** Launch Chromium once; concurrent callers await the same in-flight launch. */
function launchBrowser(): Promise<void> {
  if (!launching) {
    launching = (async () => {
      const instance = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage'],
      });
      browser = instance;
      console.log(`[browser-pilot] chromium ${instance.version()} launched`);
    })()
      .catch((err: unknown) => {
        browser = null; // failed launch → retry on next command
        throw err;
      })
      .finally(() => {
        launching = null;
      });
  }
  return launching;
}

/**
 * Ensure a healthy browser + page exist, relaunching transparently if the
 * previous ones crashed or were closed. Returns the shared page.
 */
async function ensureBrowser(): Promise<Page> {
  if (browser && !browser.isConnected()) {
    await browser.close().catch(() => {}); // best-effort cleanup of dead browser
    browser = null;
    page = null;
  }
  if (!browser) await launchBrowser();
  if (!page || page.isClosed()) {
    page = await browser!.newPage({ viewport: VIEWPORT, userAgent: USER_AGENT });
  }
  return page;
}

// ============================================================================
// Async mutex — commands execute strictly one at a time
// ============================================================================

let chain: Promise<unknown> = Promise.resolve();

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task); // run regardless of previous outcome
  chain = run.then(
    () => {},
    () => {},
  ); // swallow so the chain never dead-ends
  return run;
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
      );
      timer.unref?.();
    }),
  ]);
}

// ============================================================================
// Element enumeration (shared by /elements and ref-based targeting)
// ============================================================================

async function enumerateInteractive(currentPage: Page): Promise<ElementHit[]> {
  const handles = await currentPage.$$(INTERACTIVE_SELECTOR);
  const hits: ElementHit[] = [];
  for (const handle of handles) {
    if (hits.length >= MAX_ELEMENTS) break;
    try {
      if (!(await handle.isVisible())) continue;
      const box = await handle.boundingBox();
      if (!box || box.width < 2 || box.height < 2) continue; // meaningful size only
      const meta = await handle.evaluate((el) => {
        const html = el as HTMLElement;
        const tag = html.tagName.toLowerCase();
        const explicitRole = html.getAttribute('role');
        let role = explicitRole ?? '';
        if (!role) {
          if (tag === 'a') role = 'link';
          else if (tag === 'button') role = 'button';
          else if (tag === 'select') role = 'combobox';
          else if (tag === 'textarea') role = 'textbox';
          else if (tag === 'input') {
            const type = (html as HTMLInputElement).type || 'text';
            role =
              type === 'checkbox'
                ? 'checkbox'
                : type === 'radio'
                  ? 'radio'
                  : type === 'button' || type === 'submit' || type === 'reset'
                    ? 'button'
                    : 'textbox';
          } else role = tag;
        }
        let text = (html.innerText ?? '').trim();
        if (!text) {
          const value = (html as HTMLInputElement).value;
          if (typeof value === 'string' && value.trim()) text = value.trim();
        }
        if (!text) {
          text =
            html.getAttribute('aria-label') ||
            html.getAttribute('placeholder') ||
            html.getAttribute('title') ||
            '';
        }
        return { tag, role, text };
      });
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
      });
    } catch {
      // Element detached mid-enumeration (SPA re-render) — skip it.
    }
  }
  return hits;
}

// ============================================================================
// Helpers
// ============================================================================

/** Normalize a URL: prepend https:// when the scheme is missing; http(s) only. */
function normalizeUrl(raw: unknown): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) throw new ApiError('"url" is required');
  let candidate = value;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate)) candidate = `https://${candidate}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new ApiError(`invalid url: ${value}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ApiError(`unsupported scheme "${parsed.protocol}" — only http/https are allowed`);
  }
  return parsed.toString();
}

/** Validate a ref (element index) passed in a body. */
function requireRef(body: Record<string, unknown>): number {
  const ref = body.ref;
  if (typeof ref !== 'number' || !Number.isInteger(ref) || ref < 0) {
    throw new ApiError('"ref" must be a non-negative integer');
  }
  return ref;
}

/** Resolve a ref against a FRESH enumeration (page may have changed since /elements). */
async function resolveRef(
  currentPage: Page,
  ref: number,
): Promise<{ hit: ElementHit; total: number }> {
  const hits = await enumerateInteractive(currentPage);
  if (ref >= hits.length) {
    throw new ApiError(`ref ${ref} out of range (page currently exposes ${hits.length} interactive elements)`);
  }
  return { hit: hits[ref], total: hits.length };
}

function describeHit(hit: ElementHit): string {
  const { tag, text } = hit.info;
  return `<${tag}>${text ? ` "${text}"` : ''}`;
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const raw = await req.text();
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {}; // malformed JSON → treat as empty body; actions validate their inputs
  }
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS },
  });
}

// ============================================================================
// Actions — each returns the payload (without `ok`); the dispatcher adds it
// ============================================================================

/** POST /navigate { url } */
async function actNavigate(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const url = normalizeUrl(body.url);
  const currentPage = await ensureBrowser();
  await currentPage.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATE_TIMEOUT_MS });
  await currentPage.waitForTimeout(800); // settle: late scripts / client redirects
  return { url: currentPage.url(), title: await currentPage.title() };
}

/** POST /elements {} */
async function actElements(): Promise<Record<string, unknown>> {
  const currentPage = await ensureBrowser();
  const hits = await enumerateInteractive(currentPage);
  return {
    url: currentPage.url(),
    title: await currentPage.title(),
    elements: hits.map(({ info }) => info),
  };
}

/** POST /click { ref? , selector? , x?, y? } */
async function actClick(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const currentPage = await ensureBrowser();
  const hasRef = body.ref !== undefined;
  const selector = typeof body.selector === 'string' ? body.selector.trim() : '';
  const hasCoords = typeof body.x === 'number' && typeof body.y === 'number';

  let clicked: string;
  if (hasRef) {
    const ref = requireRef(body);
    const { hit } = await resolveRef(currentPage, ref);
    await hit.handle.click({ timeout: ELEMENT_ACTION_TIMEOUT_MS });
    clicked = `ref ${ref} ${describeHit(hit)}`;
  } else if (selector) {
    await currentPage.click(selector, { timeout: ELEMENT_ACTION_TIMEOUT_MS });
    clicked = `selector ${JSON.stringify(selector)}`;
  } else if (hasCoords) {
    const x = Math.round(body.x as number);
    const y = Math.round(body.y as number);
    await currentPage.mouse.click(x, y);
    clicked = `coordinates (${x}, ${y})`;
  } else {
    throw new ApiError('no click target — provide "ref", "selector", or "x" + "y"');
  }
  await currentPage.waitForTimeout(600); // settle after click
  return { clicked, url: currentPage.url(), title: await currentPage.title() };
}

/** POST /type { text, ref?, selector?, submit? } */
async function actType(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (typeof body.text !== 'string') throw new ApiError('"text" (string) is required');
  const currentPage = await ensureBrowser();
  const hasRef = body.ref !== undefined;
  const selector = typeof body.selector === 'string' ? body.selector.trim() : '';

  if (hasRef) {
    const ref = requireRef(body);
    const { hit } = await resolveRef(currentPage, ref);
    await hit.handle.click({ timeout: ELEMENT_ACTION_TIMEOUT_MS }); // focus the target
  } else if (selector) {
    await currentPage.click(selector, { timeout: ELEMENT_ACTION_TIMEOUT_MS });
  }
  // No ref/selector → type into whatever currently has focus.
  await currentPage.keyboard.type(body.text, { delay: 15 });
  if (body.submit === true) {
    await currentPage.keyboard.press('Enter');
    await currentPage.waitForTimeout(900); // let navigation/search land
  }
  return { url: currentPage.url(), title: await currentPage.title() };
}

/** POST /key { key } */
async function actKey(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (typeof body.key !== 'string' || !body.key.trim()) {
    throw new ApiError('"key" is required (e.g. "Enter", "Control+a")');
  }
  const currentPage = await ensureBrowser();
  await currentPage.keyboard.press(body.key.trim());
  await currentPage.waitForTimeout(400);
  return {};
}

/** POST /scroll { direction: 'up' | 'down', amount? } */
async function actScroll(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const direction = body.direction;
  if (direction !== 'up' && direction !== 'down') {
    throw new ApiError('"direction" must be "up" or "down"');
  }
  const amount =
    typeof body.amount === 'number' && Number.isFinite(body.amount) && body.amount > 0
      ? Math.min(Math.round(body.amount), 10_000)
      : 600;
  const currentPage = await ensureBrowser();
  await currentPage.mouse.wheel(0, direction === 'up' ? -amount : amount);
  await currentPage.waitForTimeout(400);
  return {};
}

/** POST /screenshot {} → jpeg base64 + viewport size */
async function actScreenshot(): Promise<Record<string, unknown>> {
  const currentPage = await ensureBrowser();
  const shot = await currentPage.screenshot({ type: 'jpeg', quality: 70 });
  const size = currentPage.viewportSize() ?? VIEWPORT;
  return {
    image: Buffer.from(shot).toString('base64'),
    url: currentPage.url(),
    title: await currentPage.title(),
    width: size.width,
    height: size.height,
  };
}

/** POST /extract {} → readable page text */
async function actExtract(): Promise<Record<string, unknown>> {
  const currentPage = await ensureBrowser();
  const raw = await currentPage.evaluate(() => (document.body?.innerText ?? '') as string);
  const text = raw
    .replace(/\n{3,}/g, '\n\n') // collapse 3+ newlines to 2
    .trim()
    .slice(0, MAX_TEXT_CHARS);
  return { url: currentPage.url(), title: await currentPage.title(), text };
}

/** POST /reset {} → close page, create a fresh one */
async function actReset(): Promise<Record<string, unknown>> {
  if (page && !page.isClosed()) {
    await page.close().catch(() => {});
  }
  page = null; // ensureBrowser() opens a fresh page (relaunching browser if dead)
  await ensureBrowser();
  return {};
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
};

// ============================================================================
// Health — read-only snapshot (never launches the browser, never queues)
// ============================================================================

async function healthPayload(): Promise<Record<string, unknown>> {
  const pageOpen = !!(page && !page.isClosed());
  let currentUrl: string | null = null;
  let title: string | null = null;
  if (pageOpen && page) {
    try {
      currentUrl = page.url();
    } catch {
      currentUrl = null;
    }
    try {
      title = await page.title();
    } catch {
      title = null;
    }
  }
  return {
    status: 'ok',
    service: 'browser-pilot',
    page_open: pageOpen,
    current_url: currentUrl,
    title,
  };
}

// ============================================================================
// Request pipeline
// ============================================================================

async function handleRequest(req: Request): Promise<Response> {
  const { pathname } = new URL(req.url);

  // CORS preflight
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });

  if (req.method === 'GET' && pathname === '/health') {
    return json(await healthPayload());
  }

  const action = ROUTES[pathname];
  if (!action) return json({ ok: false, error: `unknown route: ${req.method} ${pathname}` }, 404);
  if (req.method !== 'POST') return json({ ok: false, error: `${pathname} requires POST` }, 405);

  const body = await readBody(req);
  try {
    // Serialize (never interleave page actions) + time-box every command.
    const payload = await withTimeout(serialize(() => action(body)));
    return json({ ok: true, ...payload });
  } catch (err) {
    if (err instanceof ApiError) return json({ ok: false, error: err.message }, err.status);
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[browser-pilot] ${req.method} ${pathname} failed: ${message}`);
    return json({ ok: false, error: message }, 500);
  }
}

// ============================================================================
// HTTP server (plain Bun — no framework)
// ============================================================================

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    return handleRequest(req).catch((err: unknown) => {
      // Last-resort safety net — the server must never crash.
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[browser-pilot] unhandled error: ${message}`);
      return json({ ok: false, error: message }, 500);
    });
  },
});

// Graceful shutdown — close the browser with the process.
async function shutdown() {
  console.log('[browser-pilot] shutting down…');
  await browser?.close().catch(() => {});
  server.stop(true);
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

console.log(`[browser-pilot] listening on http://localhost:${server.port}`);
console.log('[browser-pilot] headless chromium launches lazily on first command');
