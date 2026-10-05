// M.I.S.T. × OpenJarvis — error taxonomy (port of openjarvis/agents/errors.py
// + the AgentExecutor retry rails @ 5e5f5ef, oj-spine-1).
//
// OpenJarvis classifies every managed-agent error into RetryableError /
// FatalError / EscalateError BEFORE deciding what to do: context-length
// overflows fail fast (retrying an over-length request can never succeed),
// rate limits and network blips retry with exponential backoff
// (min(10·2^attempt, 300)s), auth and permission errors escalate to a human,
// and every class carries a human-readable suggested action.
//
// M.I.S.T. adaptation: the 10 categories below cover the whole spine — LLM
// lanes AND tools. Retry policy per category maps to the cascade's actual
// behavior: `retry` = cascade to the next lane (it is the retry), `backoff` =
// retry after a delay (same lane is worth another shot), `escalate` = needs
// the creator, `fail` = deterministic, stop burning budget. User-facing
// messages follow the house voice (see BRIDGE_OFFLINE_PAYLOAD in
// tools-service.ts): honest, warm, ONE concrete next step, no apologies, no
// security lectures — plus what she CAN do right now instead.

export type ErrorCategory =
  | 'auth'
  | 'rate_limit'
  | 'network'
  | 'timeout'
  | 'context_length'
  | 'parse'
  | 'tool_error'
  | 'upstream'
  | 'guardrail'
  | 'unknown'

export type RetryPolicy = 'retry' | 'backoff' | 'escalate' | 'fail'

export interface ClassifiedError {
  category: ErrorCategory
  /** True when another attempt (next cascade lane / same lane) can succeed. */
  retryable: boolean
  /** What the engine should do with it. */
  policy: RetryPolicy
  /** Backoff seconds for policy='backoff' (port of retry_delay). */
  backoffSeconds: number
  /** Raw technical message (unchanged — for logs and traces). */
  technical: string
  /** Honest, warm, one-concrete-next-step message for the creator. */
  userMessage: string
}

// ---------- classification patterns (ported + extended) ----------

const RATE_LIMIT_PATTERNS =
  /rate.?limit|too many requests|429|quota|exceeded your|overloaded|capacity/i
const AUTH_PATTERNS =
  /unauthorized|401|403|forbidden|invalid[ _-]api[ _-]key|permission denied|access denied|not authorized/i
const TIMEOUT_PATTERNS = /timeout|timed out|deadline exceeded|aborted/i
const NETWORK_PATTERNS =
  /network|connection (reset|refused|closed|error)|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|fetch failed|socket hang up|temporary|unavailable|502|503|504|service unavailable/i
const CONTEXT_LENGTH_PATTERNS =
  /context.?length|context.?window|maximum context|too many tokens|prompt is too long|input too long|exceeds.*tokens|token limit|context_length_exceeded/i
const PARSE_PATTERNS =
  /json|parse|unexpected token|unexpected end|malformed|invalid reply|non-json|unbalanced/i
const GUARDRAIL_PATTERNS =
  /ssrf|private ip|blocked host|guardrail|not allowed by policy|capability denied|injection/i
const UPSTREAM_PATTERNS =
  /upstream|bad gateway|internal server error|500|server error|provider error|engine error|lane failed|cascade/i
const TOOL_PATTERNS =
  /unknown tool|unknown parameter|invalid argument|bad request|400|path outside allowed roots|tool execution failed|not implemented|directory|missing/i

/**
 * Classify an error message (or Error) into the spine taxonomy.
 * Order matters: deterministic failures (context_length, auth, guardrail)
 * are checked before transient ones, mirroring errors.py's "fatal patterns
 * first" rule.
 */
export function classifyError(err: string | Error | unknown): ClassifiedError {
  const technical =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : err !== null && err !== undefined
          ? String(err)
          : 'unknown error'
  const msg = technical

  // deterministic overflow — retrying the identical over-length request can
  // never succeed, so fail fast instead of burning the retry budget on it
  if (CONTEXT_LENGTH_PATTERNS.test(msg)) return build('context_length', technical, 0)
  if (AUTH_PATTERNS.test(msg)) return build('auth', technical, 0)
  if (GUARDRAIL_PATTERNS.test(msg)) return build('guardrail', technical, 0)
  if (RATE_LIMIT_PATTERNS.test(msg)) return build('rate_limit', technical, 1)
  if (TIMEOUT_PATTERNS.test(msg)) return build('timeout', technical, 1)
  if (NETWORK_PATTERNS.test(msg)) return build('network', technical, 1)
  if (PARSE_PATTERNS.test(msg)) return build('parse', technical, 0)
  if (UPSTREAM_PATTERNS.test(msg)) return build('upstream', technical, 1)
  if (TOOL_PATTERNS.test(msg)) return build('tool_error', technical, 0)
  return build('unknown', technical, 1)
}

function build(category: ErrorCategory, technical: string, defaultBackoff: number): ClassifiedError {
  const spec = CATEGORY_SPECS[category]
  return {
    category,
    retryable: spec.policy === 'retry' || spec.policy === 'backoff',
    policy: spec.policy,
    backoffSeconds: spec.policy === 'backoff' ? Math.min(10 * 2 ** defaultBackoff, 300) : 0,
    technical,
    userMessage: spec.userMessage(technical),
  }
}

/** True when the message smells like a context-window overflow (fast-fail). */
export function looksLikeContextLengthError(msg: string): boolean {
  return CONTEXT_LENGTH_PATTERNS.test(msg)
}

/**
 * Exponential backoff delay in seconds: min(10 * 2^attempt, 300).
 * Port of openjarvis/agents/errors.py retry_delay().
 */
export function retryDelay(attempt: number): number {
  return Math.min(10 * 2 ** attempt, 300)
}

// ---------- per-category policy + honest user-facing copy ----------

interface CategorySpec {
  policy: RetryPolicy
  userMessage: (technical: string) => string
}

const CATEGORY_SPECS: Record<ErrorCategory, CategorySpec> = {
  auth: {
    policy: 'escalate',
    userMessage: () =>
      'One of my lanes rejected its key. To fix it: open Settings → LLM Lanes and check the highlighted lane — I keep answering on my other lanes in the meantime, so nothing is blocked.',
  },
  rate_limit: {
    policy: 'retry',
    userMessage: () =>
      "That lane hit its rate limit — I'm already rerouting to my next lane, so just ask again; if it keeps happening I'll say so.",
  },
  network: {
    policy: 'retry',
    userMessage: () =>
      'A network hiccup cut that call short. Give it a second and ask again — if the whole network is down, my offline mind still answers simple things.',
  },
  timeout: {
    policy: 'retry',
    userMessage: () =>
      'That one ran out of time mid-thought. Try asking a slightly smaller question, or say "go deep" and I will take the long route with a bigger budget.',
  },
  context_length: {
    policy: 'fail',
    userMessage: () =>
      "This conversation has grown past my context window — no retry can fix that. Cleanest path: start a fresh chat (my memory keeps the important facts), or ask me to summarize this thread first.",
  },
  parse: {
    policy: 'fail',
    userMessage: () =>
      'A lane answered in a shape I could not read. Ask again — my cascade holds every lane to its format promise and moves on when one babbles.',
  },
  tool_error: {
    policy: 'fail',
    userMessage: (technical) =>
      `That tool could not do it: ${technical.slice(0, 160)}. Try different arguments or a different tool — I will list what actually works if you ask "what can you do".`,
  },
  upstream: {
    policy: 'retry',
    userMessage: () =>
      'The provider behind that lane errored on its side. I am cascading to the next one — ask again and you will likely land on a healthy lane.',
  },
  guardrail: {
    policy: 'fail',
    userMessage: () =>
      'I stopped that request at my security rail (private/internal address or untrusted content). Point me at a public URL instead and I will fetch it properly.',
  },
  unknown: {
    policy: 'retry',
    userMessage: () =>
      'Something unexpected broke — I do not know what yet. Ask again (my cascade retries by design); if it repeats, say "diagnose that error" and I will dig into it.',
  },
}

/** Compact honest summary for trace steps and bus events. */
export function errorSummary(classified: ClassifiedError): string {
  return `[${classified.category}] ${classified.technical.slice(0, 200)}`
}
