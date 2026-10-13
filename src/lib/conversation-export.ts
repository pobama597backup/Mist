// Conversation export (w9) — the pending "Add Conversation Export Functionality"
// proposal (cmuh8rm5r, self-idea Sep 25) finally honored. Client-side, zero
// new dependencies: builds a Markdown or JSON document from a thread and
// triggers a browser download. Faithful export — assistant content is kept
// exactly as stored (markers, citations metadata included in JSON).

'use client'

export interface ExportableMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  provider?: string
  model?: string
  created_at?: string
}

export type ExportFormat = 'md' | 'json'

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'thread'
  )
}

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
}

function ts(m: ExportableMessage): string {
  if (!m.created_at) return ''
  const d = new Date(m.created_at)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString()
}

export function buildMarkdown(title: string, messages: ExportableMessage[]): string {
  const lines: string[] = [
    `# ${title}`,
    '',
    `> Exported from M.I.S.T. — ${new Date().toLocaleString()}`,
    `> ${messages.length} message${messages.length === 1 ? '' : 's'}`,
    '',
    '---',
    '',
  ]
  for (const m of messages) {
    const who = m.role === 'user' ? 'You' : m.role === 'system' ? 'System' : 'M.I.S.T.'
    const meta: string[] = []
    if (m.provider) meta.push(m.provider)
    if (m.model) meta.push(m.model)
    const metaStr = meta.length > 0 ? ` · ${meta.join(' / ')}` : ''
    const time = ts(m)
    lines.push(`### ${who}${metaStr}${time ? ` — ${time}` : ''}`, '', m.content || '_(empty)_', '')
  }
  return lines.join('\n')
}

export function buildJson(title: string, conversationId: string | null, messages: ExportableMessage[]): string {
  return JSON.stringify(
    {
      export: 'mist-conversation',
      version: 1,
      exported_at: new Date().toISOString(),
      conversation: { id: conversationId, title },
      message_count: messages.length,
      messages,
    },
    null,
    2,
  )
}

/** Build the document and trigger a browser download. Never throws. */
export function downloadExport(
  format: ExportFormat,
  title: string,
  conversationId: string | null,
  messages: ExportableMessage[],
): void {
  try {
    if (messages.length === 0) return
    const body =
      format === 'md' ? buildMarkdown(title, messages) : buildJson(title, conversationId, messages)
    const mime = format === 'md' ? 'text/markdown;charset=utf-8' : 'application/json;charset=utf-8'
    const blob = new Blob([body], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `mist-${slugify(title)}-${stamp()}.${format}`
    document.body.appendChild(a)
    a.click()
    a.remove()
    // Give the browser a beat to start the download before revoking.
    setTimeout(() => URL.revokeObjectURL(url), 4000)
  } catch {
    // Download triggering is best-effort; never break the panel over it.
  }
}
