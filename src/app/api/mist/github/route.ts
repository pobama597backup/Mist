// M.I.S.T. GitHub mirror API (w10) — read-only by design.
// GET  → public mirror status through GitHub's unauthenticated API.
//        No token is read, stored, or accepted anywhere.
// POST → 403 forever: write access was removed by the creator's order (w10).
//        The repository is his alone — updates are pushed by him, never by Mist.
import { NextResponse } from 'next/server'
import { githubStatus } from '@/lib/services/github-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  try {
    return NextResponse.json(await githubStatus())
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'github status failed' },
      { status: 500 }
    )
  }
}

export async function POST() {
  return NextResponse.json(
    {
      error:
        'write access removed by design (w10) — the repository belongs to her creator; Mist holds no token and cannot push. Updates are published by the creator.',
    },
    { status: 403 }
  )
}
