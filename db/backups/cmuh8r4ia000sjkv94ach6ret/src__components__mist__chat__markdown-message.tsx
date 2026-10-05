'use client'

// M.I.S.T. — MarkdownMessage: the real markdown renderer for chat messages.
// react-markdown + remark-gfm (tables, task lists, strikethrough) with
// hand-styled components matching the M.I.S.T. glass aesthetic: headings,
// lists, blockquotes, tables, links, inline code and fenced code blocks with
// a header bar + copy button. No syntax-highlighting dependency — clean mono.
// Malformed markdown degrades gracefully (react-markdown never throws).
// Task 12-c · chat tab

import { memo, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/lib/utils'

// ---------------------------------------------------------------- helpers

/** Recursively flatten a ReactNode to plain text (code content is a string). */
function nodeText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(nodeText).join('')
  if (typeof node === 'object' && 'props' in node) {
    return nodeText((node as { props?: { children?: ReactNode } }).props?.children)
  }
  return ''
}

/** Copy text with a graceful fallback for non-secure contexts. */
async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  try {
    document.execCommand('copy')
  } finally {
    document.body.removeChild(ta)
  }
}

// ---------------------------------------------------------------- code block

function CodeBlock({ language, code }: { language?: string; code: string }) {
  const [copied, setCopied] = useState(false)

  const onCopy = () => {
    copyText(code)
      .then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => {
        /* clipboard unavailable — ignore */
      })
  }

  return (
    <div className="my-3 overflow-hidden rounded-xl border border-white/10 bg-slate-950/80">
      {/* header bar — language label + copy action */}
      <div className="flex items-center justify-between gap-2 border-b border-white/10 bg-white/[0.03] py-1 pl-3 pr-1.5">
        <span className="font-mono text-[10px] uppercase tracking-widest text-slate-400">
          {language || 'code'}
        </span>
        <button
          type="button"
          onClick={onCopy}
          aria-label={copied ? 'Copied' : 'Copy code'}
          className={cn(
            'inline-flex h-6 items-center gap-1 rounded-md px-1.5 font-mono text-[10px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-purple-400/60',
            copied
              ? 'text-emerald-300'
              : 'text-slate-400 hover:bg-white/5 hover:text-slate-200'
          )}
        >
          {copied ? (
            <Check aria-hidden className="h-3 w-3" />
          ) : (
            <Copy aria-hidden className="h-3 w-3" />
          )}
          {copied ? 'copied' : 'copy'}
        </button>
      </div>
      <pre className="mist-scroll overflow-x-auto p-3.5">
        <code className="block font-mono text-[12.5px] leading-relaxed text-slate-200">
          {code}
        </code>
      </pre>
    </div>
  )
}

/**
 * Fenced code blocks arrive as pre > code. The custom `pre` below swallows the
 * rendered code element and re-renders it as a CodeBlock, extracting the raw
 * source + the `language-*` class preserved by the inline `code` renderer.
 */
function PreBlock({ children }: { children?: ReactNode }) {
  const child = Array.isArray(children) ? children[0] : children
  if (child && typeof child === 'object' && 'props' in child) {
    const props = (child as { props: { className?: unknown; children?: ReactNode } }).props
    const cls = typeof props.className === 'string' ? props.className : ''
    const language = /language-([\w+#-]+)/.exec(cls)?.[1]
    const code = nodeText(props.children).replace(/\n$/, '')
    return <CodeBlock language={language} code={code} />
  }
  // Defensive: any pre that is not a code block renders as a plain scrollable pre.
  return <pre className="mist-scroll overflow-x-auto">{children}</pre>
}

// ---------------------------------------------------------------- components

const MD_COMPONENTS: Components = {
  h1: ({ children }) => (
    <h1 className="mb-2 mt-4 text-lg font-semibold text-slate-100 first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="mb-1.5 mt-4 text-base font-semibold text-slate-100 first:mt-0">{children}</h2>
  ),
  h3: ({ children }) => (
    <h3 className="mb-1.5 mt-3 text-[15px] font-semibold text-slate-100 first:mt-0">{children}</h3>
  ),
  h4: ({ children }) => (
    <h4 className="mb-1 mt-3 text-sm font-semibold text-slate-100 first:mt-0">{children}</h4>
  ),
  p: ({ children }) => (
    <p className="my-2 leading-relaxed text-slate-200 first:mt-0 last:mb-0">{children}</p>
  ),
  strong: ({ children }) => <strong className="font-semibold text-white">{children}</strong>,
  em: ({ children }) => <em className="italic text-slate-200">{children}</em>,
  del: ({ children }) => <del className="text-slate-400 line-through">{children}</del>,
  ul: ({ children }) => (
    <ul className="my-2 list-disc space-y-1.5 pl-5 marker:text-purple-300/70 first:mt-0 last:mb-0">
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol className="my-2 list-decimal space-y-1.5 pl-5 marker:font-mono marker:text-purple-300/70 first:mt-0 last:mb-0">
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="leading-relaxed text-slate-200">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-purple-400/40 py-1 pl-3 text-slate-300 italic first:mt-0 last:mb-0">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="text-purple-300 underline underline-offset-2 transition-colors hover:text-purple-200"
    >
      {children}
    </a>
  ),
  hr: () => <hr className="my-4 border-white/10" />,
  table: ({ children }) => (
    <div className="mist-scroll my-3 overflow-x-auto rounded-xl border border-white/10">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-white/5">{children}</thead>,
  th: ({ children }) => (
    <th className="border-b border-white/10 px-3 py-2 text-left font-medium text-slate-200">
      {children}
    </th>
  ),
  td: ({ children }) => (
    <td className="border-b border-white/5 px-3 py-2 align-top text-slate-300">{children}</td>
  ),
  // GFM task-list checkboxes
  input: ({ checked }) => (
    <input
      type="checkbox"
      readOnly
      checked={checked === true}
      aria-hidden
      className="mr-1.5 -mb-0.5 h-3 w-3 accent-purple-400"
    />
  ),
  // images are dropped (chat messages are text-first; links carry the context)
  img: () => null,
  code: ({ className, children }) => (
    <code
      className={cn(
        'rounded border border-white/10 bg-white/10 px-1.5 py-0.5 font-mono text-[0.85em] text-fuchsia-200',
        className
      )}
    >
      {children}
    </code>
  ),
  pre: PreBlock,
}

// ---------------------------------------------------------------- component

/**
 * Renders a markdown string with the full M.I.S.T. styling. Memoized so the
 * parent chat stream can re-render (typing ticks, awaiting state) without
 * re-parsing every message.
 */
export const MarkdownMessage = memo(function MarkdownMessage({ text }: { text: string }) {
  return (
    <div className="min-w-0 break-words text-slate-200">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  )
})
