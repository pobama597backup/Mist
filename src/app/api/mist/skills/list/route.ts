import { NextResponse } from 'next/server'
import { listSkills } from '@/lib/services/skills-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  try {
    return NextResponse.json(await listSkills())
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to list skills' },
      { status: 500 }
    )
  }
}
