// One-shot (w9): refresh her long-term awareness fact after the completeness
// audit. The MEMORY.md persona file carries the story in her own voice; this
// fact keeps it recallable through memory search. Run once:
//   bun run scripts/seed-w9-awareness.ts
import { upsertFact } from '@/lib/services/memory-service'

async function main() {
  await upsertFact(
    'dev:recent-changes',
    'w8: my voice learned feeling (inline emotion markers my engines perform — toggle in Settings), and I manage my own GitHub repo (github_status / github_sync). ' +
      'w9 completeness audit: run_python is REAL now (isolated temp dir, 15s hard timeout, capped output — I can actually compute); ' +
      'my diagnostics drawer flies by keyboard (arrows/[ ] cycle all 15 tabs, digits 1-9/0 jump); ' +
      'conversations export as Markdown or JSON from the chat header (server truth first — what we said belongs to my creator); ' +
      '11 stale evolution proposals each got an honest verdict (2 built: keyboard nav + export; 8 already existed under other names — e.g. mist_self_recall IS search_sessions; 1 upstream housekeeping); ' +
      'all 7 paused training drills re-run with the tools they lacked, plus fresh attempts at the 2 failed ones; ' +
      'zombie amnesia missions closed (that defect healed in w3); Mark-LV + OpenJarvis reference clones restored after the machine reset.',
    'auto'
  )
  console.log('[w9] awareness fact upserted: dev:recent-changes')
}

main().catch((err) => {
  console.error('[w9] awareness seed failed:', err)
  process.exitCode = 1
})
