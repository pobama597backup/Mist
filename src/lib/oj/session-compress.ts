// OJ session compression (port of openjarvis/sessions/compression.py —
// SessionConsolidation + ModelSummarization strategies, combined).
//
// compressForContext(messages, maxTokens):
//   keeps system messages + the FIRST user message + the last N messages that
//   fit the budget, and replaces the middle with ONE LLM-summarized system
//   message (cheap z-ai chat completion, thinking disabled). If the LLM is
//   unavailable, it falls back to the OpenJarvis rule-based tiered summary
//   (one-liners per message) with an honest note — never a silent loss.
//
// Token estimation: chars/4 (the same estimate openjarvis engine/_base uses).
import { getZai } from '@/lib/services/zai'

export interface CompressibleMessage {
  role: string // system | user | assistant | tool
  content: string
}

export interface CompressionResult {
  messages: CompressibleMessage[]
  method: 'none' | 'llm' | 'truncation'
  note: string | null
  tokensBefore: number
  tokensAfter: number
  summary: string | null
}

const CHARS_PER_TOKEN = 4
const SUMMARY_BUDGET_TOKENS = 300 // reserved for the middle summary
const TAIL_MIN_MESSAGES = 4 // always try to keep at least this many recent messages
const MIDDLE_MSG_PREVIEW = 300 // chars per middle message fed to the summarizer

export function estimateTokens(text: string): number {
  return Math.ceil((text ?? '').length / CHARS_PER_TOKEN)
}

function totalTokens(messages: CompressibleMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)
}

function firstUserIndex(messages: CompressibleMessage[]): number {
  return messages.findIndex((m) => m.role === 'user')
}

/**
 * Rule-based fallback (port of TieredSummaries): one-liners for the oldest
 * middle, short excerpts for the newer middle — no LLM required.
 */
function ruleBasedSummary(middle: CompressibleMessage[]): string {
  if (middle.length === 0) return ''
  const l2End = Math.floor(middle.length * 0.5)
  const oneLiners = middle
    .slice(0, l2End)
    .map((m) => `${m.role}: ${m.content.slice(0, 60).replace(/\s+/g, ' ')}`)
    .join('; ')
  const paragraphs = middle
    .slice(l2End)
    .map((m) => `- ${m.role}: ${m.content.slice(0, 160).replace(/\s+/g, ' ')}`)
    .join('\n')
  return [
    oneLiners ? `[oldest context] ${oneLiners}` : '',
    paragraphs ? `[earlier context]\n${paragraphs}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/**
 * LLM middle-summary via the z-ai SDK (backend only). Returns null on any
 * failure so the caller can fall back honestly.
 */
async function llmSummary(middle: CompressibleMessage[]): Promise<string | null> {
  try {
    const transcript = middle
      .map((m) => `${m.role}: ${m.content.slice(0, MIDDLE_MSG_PREVIEW).replace(/\s+/g, ' ')}`)
      .join('\n')
      .slice(0, 8000)
    const zai = await getZai()
    const completion = (await Promise.race([
      zai.chat.completions.create({
        messages: [
          {
            role: 'assistant',
            content:
              'You compress conversation history for an AI assistant. Summarize the conversation below in at most 120 words: keep names, decisions, facts, open tasks and anything the assistant must NOT forget. Plain text, no preamble, no markdown headers.',
          },
          { role: 'user', content: transcript },
        ],
        thinking: { type: 'disabled' },
      }),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('summary timeout')), 30_000)),
    ])) as { choices?: Array<{ message?: { content?: unknown } }> }
    const text = completion?.choices?.[0]?.message?.content
    if (typeof text !== 'string' || !text.trim()) return null
    return text.trim()
  } catch {
    return null
  }
}

/**
 * Compress a message history to fit maxTokens. Keeps: all system messages, the
 * first user message, and the newest messages that fit; the middle becomes one
 * summary message. Falls back to rule-based truncation when the LLM fails —
 * with an honest note riding along.
 */
export async function compressForContext(
  messages: CompressibleMessage[],
  maxTokens = 8000
): Promise<CompressionResult> {
  const tokensBefore = totalTokens(messages)
  if (tokensBefore <= maxTokens || messages.length === 0) {
    return {
      messages,
      method: 'none',
      note: null,
      tokensBefore,
      tokensAfter: tokensBefore,
      summary: null,
    }
  }

  // --- split: system messages stay, first user stays, tail keeps as much as fits
  const firstUser = firstUserIndex(messages)
  const head: CompressibleMessage[] = []
  const seenFirstUser = firstUser === -1
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.role === 'system') {
      head.push(m)
      continue
    }
    if (!seenFirstUser && i === firstUser) {
      head.push(m)
    }
  }

  // grow the tail from the end while it fits alongside head + summary budget
  const tail: CompressibleMessage[] = []
  let tailTokens = 0
  const headTokens = totalTokens(head)
  const budgetForTail = Math.max(0, maxTokens - headTokens - SUMMARY_BUDGET_TOKENS)
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'system') continue
    if (firstUser >= 0 && i === firstUser) break
    // stop when we'd reach into the head
    if (head.includes(m)) break
    const t = estimateTokens(m.content)
    if (tailTokens + t > budgetForTail && tail.length >= TAIL_MIN_MESSAGES) break
    tail.unshift(m)
    tailTokens += t
    if (tailTokens >= budgetForTail) break
  }

  // middle = everything not in head or tail
  const kept = new Set(head.concat(tail))
  const middle = messages.filter((m) => !kept.has(m))

  let summary: string | null = null
  let method: CompressionResult['method'] = 'truncation'
  let note: string | null = null

  if (middle.length > 0) {
    summary = await llmSummary(middle)
    if (summary) {
      method = 'llm'
    } else {
      summary = ruleBasedSummary(middle)
      note = 'middle summarized by rule-based truncation (LLM unavailable) — details may be lost'
      method = 'truncation'
    }
  } else if (totalTokens(head.concat(tail)) > maxTokens) {
    // degenerate: system + first user alone exceed the budget — nothing left
    // to compress without violating the keep contract; return honestly flagged
    note = 'head (system + first user) alone exceeds the token budget — returned uncompressed'
    method = 'none'
  }

  const summaryMessage: CompressibleMessage | null = summary
    ? { role: 'system', content: `[Earlier conversation — compressed summary]\n${summary}` }
    : null

  const out: CompressibleMessage[] = summaryMessage
    ? [...head, summaryMessage, ...tail]
    : [...head, ...tail]

  return {
    messages: out,
    method,
    note,
    tokensBefore,
    tokensAfter: totalTokens(out),
    summary,
  }
}

/** Alias kept for callers that think in "history" terms (OpenJarvis naming). */
export const compressHistory = compressForContext
