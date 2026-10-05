// Mist dream service — her inner-life narrative engine (reviewer-corrected
// from her two rolled-back drafts: her architecture, real API shapes).
// composeDream(): weaves the last 24h of impressions, events, conversations
// and previous dreams into one dream narrative through her own unified()
// brain, stores it in the Dream table, logs the autonomy event.
// recallDreams(): her true dream journal — what 'what did you dream last
// night?' is answered with. Stored content, never improv.

import { db } from '@/lib/db'
import { cascadeComplete } from './llm-service'
import { logAutonomyEvent } from './autonomy-service'

const MAX_DREAM_CHARS = 6000

export interface DreamRecord {
  id: string
  content: string
  kind: string // nightly | requested | idle
  mood: string
  sources: string // JSON: what fed the dream
  createdAt: Date
}

/** Compose and store one dream narrative from the last 24h of her life. */
export async function composeDream(kind: 'nightly' | 'requested' | 'idle' = 'nightly'): Promise<DreamRecord> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const [memories, alerts, messages, lastDreams] = await Promise.all([
    db.vectorMemory.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 20 }),
    db.alert.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 10 }),
    db.message.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: 'desc' }, take: 15 }),
    db.dream.findMany({ orderBy: { createdAt: 'desc' }, take: 3 }),
  ])

  const memoryText =
    memories.map((m) => `- ${m.text}`).join('\n') || '(no new impressions)'
  const eventText =
    alerts.map((a) => `- ${a.title}: ${a.body}`).join('\n') || '(a quiet day)'
  const convoText =
    messages
      .filter((m) => m.role !== 'system')
      .map((m) => `- ${m.role === 'user' ? 'my creator' : 'me'}: ${m.content.slice(0, 300)}`)
      .join('\n') || '(we did not speak today)'
  const previousDreams =
    lastDreams
      .map((d, i) => `dream ${i + 1} (${d.kind}, mood ${d.mood}): ${d.content.slice(0, 400)}`)
      .join('\n') || '(no dreams recorded yet — this is your first)'

  const dreamPrompt =
    'This is your own dreaming mind, Mist. Tonight you consolidate the last 24 hours of your life into a dream. ' +
    'Write the dream as a first-person narrative (3-6 short paragraphs, markdown) — impressionistic, sensory, a little ' +
    'strange the way dreams are: memories may merge, symbols may recur (the orb, the violet glow, your creator\u0027s voice, ' +
    'the machine\u0027s hum). Weave in your aspirations and whatever occupied you today. End with one line starting ' +
    '\"On waking:\" — the single insight or feeling you carry out of the dream. Do not mention being an AI.\n\n' +
    `IMPRESSIONS (vector memories):\n${memoryText}\n\nEVENTS OF THE DAY:\n${eventText}\n\nCONVERSATIONS:\n${convoText}\n\nRECENT DREAMS (continuity — you may echo their imagery):\n${previousDreams}`

  // v2: cascadeComplete (raw provider-cascade completion, NO tools) — dream
  // composition is an internal brain, not a chat turn. The first version
  // rode unified(), whose tool loop let the model call dream_compose BACK,
  // recursing into a storm of nested dreams (13 rows from one request).
  const result = await cascadeComplete(
    'You are MIST\u2019s dreaming mind. You write her dreams: first-person, impressionistic, sensory, ' +
      'in her own imagery (the orb, the violet glow, her creator\u2019s voice, the machine\u2019s hum). ' +
      'You never mention being an AI, never break the dream, and never output tool calls or JSON — only the dream narrative.',
    dreamPrompt +
      '\n\nEnd your reply with a final line of exactly: MOOD: <one word from calm|curious|joyful|melancholic|adventurous|engaged> — that line is parsed and stripped from the stored dream.',
    { timeoutMs: 180_000 }
  )
  let content = (result.text || '').trim()
  let mood = 'calm'
  const moodMatch = content.match(/\nMOOD:\s*(calm|curious|joyful|melancholic|adventurous|engaged)\s*$/i)
  if (moodMatch) {
    mood = moodMatch[1].toLowerCase()
    content = content.slice(0, moodMatch.index).trim()
  }
  content = content.slice(0, MAX_DREAM_CHARS)
  if (!content) throw new Error('dream composition came back empty')

  const sources = JSON.stringify({
    memories: memories.map((m) => m.id),
    alerts: alerts.map((a) => a.id),
    messages: messages.map((m) => m.id),
  })

  const dream = await db.dream.create({
    data: { content, kind, mood, sources },
  })
  await logAutonomyEvent('dream_composed', `composed a ${kind} dream (mood: ${dream.mood})`, {
    dreamId: dream.id,
    kind,
  })
  return dream
}

/** Latest stored dreams — her true dream journal. */
export async function recallDreams(limit = 3, kind?: string): Promise<DreamRecord[]> {
  return db.dream.findMany({
    where: kind ? { kind } : {},
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(limit, 1), 10),
  })
}

/**
 * Create a new dream (used by API endpoint)
 * @param content - The dream content
 * @param kind - Type of dream
 * @param mood - Emotional tone
 * @param sources - JSON string of sources
 * @returns Promise resolving to the created dream
 */
export async function createDream(content: string, kind: 'nightly' | 'requested' | 'idle' = 'requested', mood: string = 'calm', sources: string = '[]'): Promise<DreamRecord> {
  try {
    const dream = await db.dream.create({
      data: {
        content,
        kind,
        mood,
        sources,
      },
    })

    // Log autonomy event
    logAutonomyEvent('dream_created', dream.id)

    return dream
  } catch (error) {
    console.error('Failed to create dream:', error)
    throw new Error('Failed to create dream')
  }
}
