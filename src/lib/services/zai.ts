// z-ai-web-dev-sdk — SERVER-ONLY singleton (memoized creation promise)
import ZAI from 'z-ai-web-dev-sdk'

let zaiPromise: Promise<Awaited<ReturnType<typeof ZAI.create>>> | null = null

export function getZai() {
  zaiPromise ??= ZAI.create()
  return zaiPromise
}
