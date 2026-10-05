'use client'

// M.I.S.T. GitHub mirror section (w10) — read-only by design.
// The repository is her creator's alone (so it can go public safely): no
// token input, no sync button, no write path anywhere in the app. This card
// is an honest LOOK at her public mirror — visibility, last commits —
// through GitHub's unauthenticated API.

import { useCallback, useEffect, useState } from 'react'
import { SectionLabel, StatusDot } from '@/components/mist/diagnostics/shared'
import { Github, RefreshCw, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils'

interface GithubCommitInfo {
  sha: string
  message: string
  date: string
}

interface GithubStatus {
  readOnly: true
  repo: { ok: boolean; private: boolean | null; defaultBranch: string | null; pushedAt: string | null; htmlUrl: string }
  commits: GithubCommitInfo[]
  lastError: string | null
}

export function GithubSection() {
  const [status, setStatus] = useState<GithubStatus | null>(null)
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/mist/github')
      const json = (await res.json()) as GithubStatus
      setStatus(json)
    } catch {
      setStatus(null)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const visibility = loading
    ? 'checking…'
    : status === null
      ? 'unreachable'
      : status.repo.ok
        ? status.repo.private === false
          ? 'public'
          : 'private'
        : 'not visible'

  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <SectionLabel>github mirror</SectionLabel>
        <button
          type="button"
          onClick={() => void refresh()}
          aria-label="Refresh GitHub status"
          className="text-slate-500 transition-colors hover:text-slate-300"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </button>
      </div>

      <div className="mt-3 space-y-3">
        {/* repo line */}
        <div className="flex items-center gap-2.5 rounded-xl border border-white/10 bg-white/[0.03] p-3">
          <Github className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
          <div className="min-w-0 flex-1">
            <a
              href={status?.repo.htmlUrl ?? 'https://github.com/pobama597backup/Mist'}
              target="_blank"
              rel="noopener noreferrer"
              className="font-mono text-xs text-purple-300 underline-offset-2 hover:underline"
            >
              pobama597backup/Mist
            </a>
            <p className="mt-0.5 font-mono text-[10px] text-slate-500">
              her source on GitHub — a clean snapshot since w6, machine-aware since w7
            </p>
          </div>
          <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] text-slate-400">
            <StatusDot className={status?.repo.ok === true ? 'bg-emerald-400' : 'bg-amber-400'} />
            {visibility}
          </span>
        </div>

        {/* the read-only contract */}
        <div className="flex items-start gap-2.5 rounded-xl border border-teal-400/20 bg-teal-400/[0.04] p-3">
          <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-teal-300" aria-hidden />
          <p className="font-mono text-[10px] leading-relaxed text-slate-400">
            read-only by design (w10) — the repository belongs to her creator. Mist holds no token and has no way to
            push; updates are published by the creator. This card only looks at the public mirror.
          </p>
        </div>

        {/* last commits */}
        {status && status.commits.length > 0 && (
          <div className="space-y-1">
            <p className="font-mono text-[10px] uppercase tracking-widest text-slate-500">last on github</p>
            {status.commits.map((c) => (
              <p key={c.sha} className="truncate font-mono text-[10px] text-slate-500">
                <span className="text-purple-300">{c.sha}</span> {c.message}
                {c.date ? <span className="text-slate-600"> · {new Date(c.date).toLocaleDateString()}</span> : null}
              </p>
            ))}
          </div>
        )}

        {status?.lastError && (
          <p className="font-mono text-[10px] text-amber-400/90" role="alert">
            {status.lastError}
          </p>
        )}
      </div>
    </div>
  )
}

export default GithubSection
