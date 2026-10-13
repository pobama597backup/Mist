'use client'

// M.I.S.T. GitHub mirror section (w8) — the creator's control surface for her
// self-hosted source: paste a token once, see the honest state of the repo,
// and push an update of herself to GitHub. She has the same power herself via
// her github_sync / github_status tools — this is the human-facing twin.

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SectionLabel, StatusDot } from '@/components/mist/diagnostics/shared'
import { Github, RefreshCw, Trash2, UploadCloud } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

interface GithubCommitInfo {
  sha: string
  message: string
  date: string
}

interface GithubStatus {
  tokenPresent: boolean
  tokenValid: boolean | null
  repo: { ok: boolean; private: boolean | null; defaultBranch: string | null; pushedAt: string | null; htmlUrl: string }
  commits: GithubCommitInfo[]
  exportReady: boolean
  dirtyFiles: number
  lastError: string | null
}

interface SyncResult {
  ok: boolean
  committed: boolean
  pushed: boolean
  filesChanged: number
  commitSha?: string
  message?: string
  error?: string
}

export function GithubSection() {
  const [status, setStatus] = useState<GithubStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [lastSync, setLastSync] = useState<string | null>(null)

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
    // deferred to a macrotask — refresh() setStates synchronously (setLoading)
    const id = window.setTimeout(() => void refresh(), 0)
    return () => window.clearTimeout(id)
  }, [refresh])

  const saveToken = async () => {
    const t = token.trim()
    if (!t) {
      toast.error('paste a token first')
      return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/mist/github', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'save-token', token: t }),
      })
      const json = (await res.json()) as { ok?: boolean; error?: string }
      if (json.ok) {
        toast.success('token saved and validated — she can update herself on GitHub now')
        setToken('')
        await refresh()
      } else {
        toast.error(json.error ?? 'token rejected')
      }
    } catch {
      toast.error('could not reach the github service')
    } finally {
      setSaving(false)
    }
  }

  const clearToken = async () => {
    setSaving(true)
    try {
      await fetch('/api/mist/github', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'clear-token' }),
      })
      toast('token removed from this machine', { description: 'the repo keeps its history' })
      await refresh()
    } finally {
      setSaving(false)
    }
  }

  const sync = async () => {
    setSyncing(true)
    setLastSync(null)
    try {
      const res = await fetch('/api/mist/github', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sync' }),
      })
      const json = (await res.json()) as SyncResult
      if (json.ok && json.pushed) {
        setLastSync(`pushed ${json.filesChanged} file(s) — ${json.commitSha} · ${json.message ?? ''}`)
        toast.success(`update pushed — ${json.filesChanged} files, commit ${json.commitSha}`)
      } else if (json.ok) {
        setLastSync(json.message ?? 'already up to date')
        toast(json.message ?? 'already up to date')
      } else {
        setLastSync(json.error ?? 'sync failed')
        toast.error(json.error ?? 'sync failed')
      }
      await refresh()
    } catch {
      setLastSync('sync failed — the github service is unreachable')
      toast.error('sync failed')
    } finally {
      setSyncing(false)
    }
  }

  const tokenState = loading
    ? 'checking…'
    : status === null
      ? 'unreachable'
      : !status.tokenPresent
        ? 'no token on this machine'
        : status.tokenValid === false
          ? 'token rejected — paste a fresh one'
          : status.repo.ok
            ? 'token valid · repo reachable'
            : status.lastError ?? 'token saved'

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
              her source — pushed from the birth machine in w6, machine-aware since w7
            </p>
          </div>
          <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] text-slate-400">
            <StatusDot className={status?.repo.ok === true ? 'bg-emerald-400' : 'bg-amber-400'} />
            {status?.repo.ok === true ? (status.repo.private === false ? 'public' : 'private') : 'offline'}
          </span>
        </div>

        {/* token */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={status?.tokenPresent ? 'token saved — paste a new one to replace' : 'paste a classic GitHub token (repo scope, ghp_…)'}
              aria-label="GitHub token"
              className="h-9 border-white/10 bg-white/5 font-mono text-xs text-slate-200"
              autoComplete="off"
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void saveToken()}
              disabled={saving || !token.trim()}
              className="h-9 shrink-0 border-white/10 bg-white/5 text-xs text-slate-200 hover:bg-white/10"
            >
              {saving ? 'checking…' : 'save'}
            </Button>
            {status?.tokenPresent && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => void clearToken()}
                disabled={saving}
                aria-label="Remove the saved token"
                className="h-9 shrink-0 text-xs text-slate-500 hover:text-rose-300"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
          <p className="font-mono text-[10px] text-slate-500">
            token: <span className={cn(status?.tokenValid === false ? 'text-amber-400' : status?.tokenPresent ? 'text-emerald-300' : 'text-slate-500')}>{tokenState}</span>
            <span className="mx-1.5 text-slate-700">·</span>
            stored in db/provider-keys.json — never leaves this machine, never enters the export
          </p>
        </div>

        {/* sync */}
        <div className="flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-white/[0.03] p-3">
          <div className="min-w-0">
            <p className="text-xs text-slate-300">Update her on GitHub</p>
            <p className="mt-0.5 font-mono text-[10px] text-slate-500">
              {status?.exportReady
                ? `export ready${status.dirtyFiles > 0 ? ` · ${status.dirtyFiles} uncommitted change(s)` : ' · clean'}`
                : 'export initializes on the first push (clone of the repo, history preserved)'}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            onClick={() => void sync()}
            disabled={syncing || loading || status?.tokenPresent !== true}
            className="h-9 shrink-0 gap-1.5 bg-purple-500/80 text-xs text-white hover:bg-purple-500"
          >
            <UploadCloud className="h-3.5 w-3.5" />
            {syncing ? 'pushing…' : 'sync & push'}
          </Button>
        </div>

        {lastSync && (
          <p className="break-words font-mono text-[10px] text-slate-400" role="status">
            {lastSync}
          </p>
        )}

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
