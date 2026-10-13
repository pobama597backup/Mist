import { NextResponse } from 'next/server'
import type { ToolCategory } from '@/lib/types'
import { routeError } from '@/lib/route-error'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

const CATEGORIES: ToolCategory[] = [
  'web',
  'file',
  'system',
  'compute',
  'io',
  'memory',
  'utility',
  'omniroute',
  'skill',
]

export async function GET() {
  // Phase 3-a · R12: the constant cannot realistically throw, but the rule
  // is the rule for every /api/mist route — JSON errors only, never HTML.
  try {
    return NextResponse.json(CATEGORIES)
  } catch (err) {
    return routeError(err, 'tool categories failed')
  }
}
