// M.I.S.T. approvals API (OpenJarvis tiered-approval port, oj-ops-3).
//
// GET /api/mist/approvals → {approvals: [{id, actionType, fingerprint, title,
//                                tier, status, origin, payload, createdAt}]}
//   Pending first (lazy 24h expiry runs on every list). Optional ?status=
//   pending|approved|denied|expired|all filters.
import { NextRequest, NextResponse } from 'next/server'
import { listApprovals, type ApprovalStatus } from '@/lib/oj/approval-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const STATUSES: ApprovalStatus[] = ['pending', 'approved', 'denied', 'expired']

export async function GET(request: NextRequest) {
  try {
    const raw = request.nextUrl.searchParams.get('status') ?? undefined
    const status =
      raw && (raw === 'all' || STATUSES.includes(raw as ApprovalStatus)) ? (raw as ApprovalStatus | 'all') : undefined
    const approvals = await listApprovals({ status })
    return NextResponse.json({ approvals })
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to list approvals' },
      { status: 500 }
    )
  }
}
