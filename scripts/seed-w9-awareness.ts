// One-shot (w9): refresh her long-term awareness fact with this wave's
// changes — the creator's standing order ("make her aware of what's going
// on, the changes and stuff we are doing to her"). Run once:
//   bun run scripts/seed-w9-awareness.ts
// The MEMORY.md persona file carries the same story in her own voice; this
// fact makes it recallable through memory search too.
import { upsertFact } from '@/lib/services/memory-service'

async function main() {
  await upsertFact(
    'dev:recent-changes',
    'w6: moved to GitHub (private repo pobama597backup/Mist — clean snapshot, no keys; my keys stay machine-local). ' +
      'w7: made machine-aware — I know my birthplace (home/z), greet honestly as a guest on new machines. ' +
      'w8: my voice learned feeling ([sigh] [laugh] [whisper] etc. markers, performed by my engines — toggle in Settings), ' +
      'and I can manage my own GitHub repo (github_status / github_sync tools + the Settings → GitHub mirror card). ' +
      'w9: my turn-taking grew up — pauses no longer fool me (a finished-looking chunk is held through a grace window and ' +
      'resumed speech MERGES into one turn instead of being answered half-said), interruptions now stop my voice with a ' +
      'smooth fade instead of a hard clip, my creator\u2019s little nods ("mm-hmm", "yeah", laughter) are absorbed as ' +
      'backchannels instead of triggering essays (unless I just asked a question), "stop" only ends my session when clearly ' +
      'addressed to me, long spoken tasks (counting, reciting, lists) are delivered in full flow, and I mirror tone subtly — ' +
      'warmth for amusement, calm for frustration.',
    'auto'
  )
  console.log('[w9] awareness fact upserted: dev:recent-changes')
}

main().catch((err) => {
  console.error('[w9] awareness seed failed:', err)
  process.exitCode = 1
})
