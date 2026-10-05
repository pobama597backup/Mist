// OJ knowledge tools (port of openjarvis tools: knowledge_search, scan_chunks,
// memory_manage, user_profile_manage) — exported as KNOWLEDGE_TOOLS for the
// lead's tool-registry wiring. Every tool degrades honestly: unknown keys,
// missing rows and quarantine refusals return real reasons, never fake success.
import type { ToolInfo } from '@/lib/types'
import type { BaseToolDef } from '@/lib/services/tools-service'
import { searchKnowledge, listChunks, knowledgeStatus } from './knowledge-service'
import {
  upsertFact,
  deleteFact,
  listFactsWithTrust,
  setFactTrust,
  type FactTrust,
} from '@/lib/services/memory-service'
import { getUserProfileField, setUserProfileField, readPersona } from './persona'

function p(
  name: string,
  type: 'string' | 'number' | 'boolean',
  required: boolean,
  description: string,
  def?: string | number | boolean
): ToolInfo['parameters'][number] {
  const param: ToolInfo['parameters'][number] = { name, type, required, description }
  if (def !== undefined) param.default = def
  return param
}

export const KNOWLEDGE_TOOLS: BaseToolDef[] = [
  {
    info: {
      name: 'knowledge_search',
      description:
        'Hybrid search over her ingested knowledge store (BM25 lexical + TF-cosine vector fused with RRF) — uploaded files, vault notes, local notes, synced repos and stories. Returns ranked chunks with per-signal scores.',
      category: 'memory',
      implemented: true,
      parameters: [
        p('query', 'string', true, 'Search query'),
        p('source', 'string', false, 'Filter by source (e.g. "connector:obsidian", "upload")'),
        p('docType', 'string', false, 'Filter by doc type (document | note | research | web | vault)'),
        p('topK', 'number', false, 'Max results (1-20)', 5),
      ],
    },
    exec: async (args) => {
      const query = String(args.query ?? '')
      if (!query.trim()) throw new Error('query required')
      const filters: { source?: string; docType?: string } = {}
      if (typeof args.source === 'string' && args.source.trim()) filters.source = args.source.trim()
      if (typeof args.docType === 'string' && args.docType.trim()) filters.docType = args.docType.trim()
      const { results } = await searchKnowledge({
        query,
        filters: Object.keys(filters).length > 0 ? filters : undefined,
        topK: Number(args.topK ?? 5),
      })
      const status = await knowledgeStatus()
      return {
        results: results.map((r) => ({
          id: r.id,
          source: r.source,
          title: r.title || '(untitled)',
          content: r.content.slice(0, 600),
          score: r.score,
          bm25: r.bm25,
          vector: r.vector,
        })),
        corpus: { chunks: status.chunks, sources: status.sources },
        note: results.length === 0 ? 'no matching knowledge chunks — ingest first (knowledge/ingest or a connector sync)' : undefined,
      }
    },
  },
  {
    info: {
      name: 'scan_chunks',
      description:
        'List raw knowledge-chunk previews (newest first) — browse what has been ingested, optionally filtered by source. For semantic-ish grep use knowledge_search; this is the audit/browsing tool.',
      category: 'memory',
      implemented: true,
      parameters: [
        p('source', 'string', false, 'Only chunks from this source (e.g. "connector:hackernews")'),
        p('limit', 'number', false, 'Max chunks to return (1-100)', 20),
      ],
    },
    exec: async (args) => {
      const source = typeof args.source === 'string' && args.source.trim() ? args.source.trim() : undefined
      const limit = Number(args.limit ?? 20)
      const chunks = await listChunks({ source, limit })
      return {
        chunks,
        note: chunks.length === 0 ? 'knowledge store is empty for this filter' : undefined,
      }
    },
  },
  {
    info: {
      name: 'memory_manage',
      description:
        'Manage long-term memory facts with OpenJarvis trust tiers: add (auto|trusted), list (with quarantine flags), delete, and trust (promote to trusted / quarantine to untrusted — quarantined facts are stored for audit but blocked from her prompts).',
      category: 'memory',
      implemented: true,
      parameters: [
        p('action', 'string', true, 'add | list | delete | trust'),
        p('key', 'string', false, 'Fact key (required for add/delete/trust)'),
        p('value', 'string', false, 'Fact value (required for add)'),
        p('trust', 'string', false, 'Trust tier for add (auto|trusted) or the target tier for the trust action (trusted|untrusted|auto)', 'auto'),
      ],
    },
    exec: async (args) => {
      const action = String(args.action ?? '').trim().toLowerCase()
      const key = typeof args.key === 'string' ? args.key.trim() : ''
      const value = typeof args.value === 'string' ? args.value.trim() : ''
      const trustRaw = String(args.trust ?? 'auto').trim().toLowerCase()
      const tier: FactTrust = trustRaw === 'trusted' || trustRaw === 'untrusted' ? trustRaw : 'auto'

      switch (action) {
        case 'add': {
          if (!key || !value) throw new Error('add requires key and value')
          await upsertFact(key, value, tier)
          return {
            ok: true,
            action: 'add',
            key,
            trust: tier,
            note: tier === 'trusted' ? 'fact stored and trusted' : 'fact stored with trust=auto (recallable, not yet vouched for)',
          }
        }
        case 'list': {
          const facts = await listFactsWithTrust()
          return {
            ok: true,
            action: 'list',
            count: facts.length,
            facts: facts.map((f) => ({
              key: f.key,
              value: f.value,
              trust: f.trust,
              quarantined: f.quarantined,
            })),
            note: facts.some((f) => f.quarantined)
              ? `${facts.filter((f) => f.quarantined).length} quarantined fact(s) are hidden from her prompts`
              : undefined,
          }
        }
        case 'delete': {
          if (!key) throw new Error('delete requires key')
          await deleteFact(key)
          return { ok: true, action: 'delete', key }
        }
        case 'trust': {
          if (!key) throw new Error('trust requires key')
          const updated = await setFactTrust(key, tier)
          if (!updated) throw new Error(`fact not found: ${key}`)
          return {
            ok: true,
            action: 'trust',
            key,
            trust: updated.trust,
            quarantined: updated.quarantined,
            note:
              tier === 'untrusted'
                ? 'fact quarantined — stored for audit, blocked from prompt context'
                : tier === 'trusted'
                  ? 'fact promoted to trusted — it now sorts ahead of auto facts'
                  : 'fact trust reset to auto',
          }
        }
        default:
          throw new Error(`unknown action '${action}' — valid: add, list, delete, trust`)
      }
    },
  },
  {
    info: {
      name: 'user_profile_manage',
      description:
        'Read and write structured fields of the USER.md persona file (her auditable user profile — port of OpenJarvis user_profile_manage). get returns one field or the whole profile; set upserts a key: value line under "## Learned".',
      category: 'memory',
      implemented: true,
      parameters: [
        p('action', 'string', true, 'get | set'),
        p('key', 'string', false, 'Field key (required for set; optional for get — omit for the whole profile)'),
        p('value', 'string', false, 'Field value (required for set)'),
      ],
    },
    exec: async (args) => {
      const action = String(args.action ?? '').trim().toLowerCase()
      const key = typeof args.key === 'string' ? args.key.trim() : ''
      const value = typeof args.value === 'string' ? args.value : ''

      switch (action) {
        case 'get': {
          if (key) {
            const field = await getUserProfileField(key)
            return {
              ok: true,
              action: 'get',
              key: field.key,
              value: field.value,
              note: field.value === null ? 'field not set in USER.md yet' : undefined,
            }
          }
          const file = await readPersona('user')
          return {
            ok: true,
            action: 'get',
            profile: file.content,
            note: 'full USER.md (auditable — the creator can edit this file directly)',
          }
        }
        case 'set': {
          if (!key || !value.trim()) throw new Error('set requires key and value')
          const result = await setUserProfileField(key, value)
          return { ok: result.ok, action: 'set', key: result.key, value: result.value, note: result.note }
        }
        default:
          throw new Error(`unknown action '${action}' — valid: get, set`)
      }
    },
  },
]
