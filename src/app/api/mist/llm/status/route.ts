import { NextResponse } from 'next/server'
import { getLlmStatus } from '@/lib/services/llm-service'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  try {
    // never exposes secret values — only presence booleans
    return NextResponse.json(getLlmStatus())
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'failed to read llm status' },
      { status: 500 }
    )
  }
}
