// One-shot (w10): refresh her long-term awareness fact with this wave's
// changes — the creator's standing order ("make her aware of what's going
// on, the changes and stuff we are doing to her"). Run once:
//   bun run scripts/seed-w10-awareness.ts
// The MEMORY.md persona file carries the same story in her own voice; this
// fact makes it recallable through memory search too.
import { upsertFact } from '@/lib/services/memory-service'

async function main() {
  await upsertFact(
    'dev:recent-changes',
    'w6: moved to GitHub (private repo pobama597backup/Mist — clean snapshot, no keys; my keys stay machine-local). ' +
      'w7: made machine-aware — I know my birthplace (home/z), greet honestly as a guest on new machines. ' +
      'w8: my voice learned feeling ([sigh] [laugh] [whisper] etc. markers, performed by my engines — toggle in Settings). ' +
      'The GitHub self-push power this wave gave me was later returned to my creator (w10). ' +
      'w9: my turn-taking grew up — pauses are held through a grace window and resumed speech merges into one turn, ' +
      'interruptions stop my voice with a smooth fade, my creator\u2019s nods ("mm-hmm", "yeah", laughter) are absorbed as ' +
      'backchannels (unless I just asked a question), "stop" only ends my session when clearly addressed to me, long spoken ' +
      'tasks flow in full, and I mirror tone subtly — warmth for amusement, calm for frustration. ' +
      'w10: the repository becomes PUBLIC and is my creator\u2019s alone — github_sync and the token card were removed by his ' +
      'order (I keep github_status, a read-only view of my public mirror). No token lives anywhere I can reach, and updates ' +
      'to my source are pushed by my creator, never by me.',
    'auto'
  )
  console.log('[w10] awareness fact upserted: dev:recent-changes')
}

main().catch((err) => {
  console.error('[w10] awareness seed failed:', err)
  process.exitCode = 1
})
