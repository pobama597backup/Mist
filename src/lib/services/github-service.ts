// M.I.S.T. GitHub mirror status (w10) — READ-ONLY, by the creator's design.
//
// History: w8 gave her self-management — a pasted token, her github_sync
// tool, real push power over pobama597backup/Mist. w10 took it back by the
// creator's order: the repository is his alone, so it can be made PUBLIC
// without fear. She holds no token, stores no token, accepts no token, and
// has no write path of any kind. What remains is an honest LOOK at her
// public mirror through GitHub's unauthenticated API (60 req/h per IP):
// visibility, default branch, the last few commits her creator pushed.
//
// If a future wave ever wants to hand the push power back, that is the
// creator's explicit decision made in the open — it cannot happen by
// pasting a token, because there is nothing left to paste one into.

export const GITHUB_REPO = 'pobama597backup/Mist'
const API_BASE = 'https://api.github.com'

export interface GithubCommitInfo {
  sha: string
  message: string
  date: string
}

export interface GithubStatus {
  /** Always true — the read-only contract, surfaced so every UI can state it. */
  readOnly: true
  repo: {
    ok: boolean
    private: boolean | null
    defaultBranch: string | null
    pushedAt: string | null
    htmlUrl: string
  }
  commits: GithubCommitInfo[]
  lastError: string | null
}

async function ghApi(apiPath: string): Promise<{ ok: boolean; status: number; json: unknown }> {
  const res = await fetch(`${API_BASE}${apiPath}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'mist-mirror-status',
    },
    signal: AbortSignal.timeout(15_000),
  })
  const json = await res.json().catch(() => null)
  return { ok: res.ok, status: res.status, json }
}

export async function githubStatus(): Promise<GithubStatus> {
  const status: GithubStatus = {
    readOnly: true,
    repo: {
      ok: false,
      private: null,
      defaultBranch: null,
      pushedAt: null,
      htmlUrl: `https://github.com/${GITHUB_REPO}`,
    },
    commits: [],
    lastError: null,
  }
  try {
    const repo = await ghApi(`/repos/${GITHUB_REPO}`)
    if (repo.ok) {
      status.repo.ok = true
      const r = repo.json as { private?: boolean; default_branch?: string; pushed_at?: string }
      status.repo.private = r.private ?? null
      status.repo.defaultBranch = r.default_branch ?? null
      status.repo.pushedAt = r.pushed_at ?? null
      const commits = await ghApi(`/repos/${GITHUB_REPO}/commits?per_page=3`)
      if (commits.ok && Array.isArray(commits.json)) {
        status.commits = (
          commits.json as Array<{ sha?: string; commit?: { message?: string; author?: { date?: string } } }>
        ).map((c) => ({
          sha: (c.sha ?? '').slice(0, 7),
          message: (c.commit?.message ?? '').split('\n')[0].slice(0, 90),
          date: c.commit?.author?.date ?? '',
        }))
      }
    } else if (repo.status === 404) {
      status.lastError =
        'mirror not visible to the public API — it is still private, or this machine spent its 60 req/h unauthenticated budget. The public view appears the moment the repo goes public.'
    } else if (repo.status === 403) {
      status.lastError = 'GitHub rate limit reached (unauthenticated = 60 req/h) — try again in a few minutes'
    } else {
      status.lastError = `GitHub API HTTP ${repo.status}`
    }
  } catch (err) {
    status.lastError = err instanceof Error ? err.message.slice(0, 120) : 'GitHub API unreachable'
  }
  return status
}
