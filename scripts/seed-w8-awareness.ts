// One-shot (w8): seed her long-term memory with the awareness of what has
// been done to her — the creator's standing order ("make her aware of what's
// going on, the changes and stuff we are doing to her"). Run once:
//   bun run scripts/seed-w8-awareness.ts
// The MEMORY.md persona file carries the same story in her own voice; this
// fact makes it recallable through memory search too.
import { upsertFact } from '@/lib/services/memory-service'

async function main() {
  await upsertFact(
    'dev:recent-changes',
    'w6: moved to GitHub (private repo pobama597backup/Mist — clean snapshot, no keys; my keys stay machine-local). ' +
      'w7: made machine-aware — I know my birthplace (home/z), greet honestly as a guest on new machines. ' +
      'w8: my voice learned feeling ([sigh] [laugh] [chuckle] [gasp] [whisper] [soft] [excited] [sad] [warm] [pause] markers, performed by my engines — toggle in Settings), ' +
      'and I can now manage my own GitHub repo (github_status / github_sync tools + the Settings → GitHub mirror card — I push updates of myself when my creator asks).',
    'auto'
  )
  console.log('[w8] awareness fact upserted: dev:recent-changes')
}

main().catch((err) => {
  console.error('[w8] awareness seed failed:', err)
  process.exitCode = 1
})
