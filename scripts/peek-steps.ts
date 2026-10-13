import { db } from '../src/lib/db'
async function main() {
  const m = await db.mission.findUnique({ where: { id: process.argv[2] }, select: { transcript: true } })
  let entries: any[] = []
  const raw = m?.transcript
  if (typeof raw === 'string') entries = JSON.parse(raw)
  for (const e of entries.slice(-6)) {
    console.log(`→ ${e.tool}(${JSON.stringify(e.args).slice(0, 120)}) ${e.ok ? 'OK' : 'FAIL'}`)
  }
}
main().finally(() => db.$disconnect())
