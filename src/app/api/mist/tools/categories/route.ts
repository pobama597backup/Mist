import { NextResponse } from 'next/server'
import type { ToolCategory } from '@/lib/types'

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
  return NextResponse.json(CATEGORIES)
}
