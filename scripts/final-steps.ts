import { db } from '../src/lib/db'
async function main() {
  const m = await db.mission.findUnique({ where: { id: process.argv[2] }, select: { transcript: true, verification: true } })
  let entries: any[] = []
  const raw = m?.transcript
  if (typeof raw === 'string') entries = JSON.parse(raw)
  console.log('LAST 8 STEPS:')
  for (const e of entries.slice(-8)) {
    console.log(`→ ${e.tool}(${JSON.stringify(e.args).slice(0, 150)}) ${e.ok ? 'OK' : 'FAIL'}`)
  }
  if (m?.verification) console.log('\nVERIFICATION:', String(m.verification).slice(0, 600))
}
main().finally(() => db.$disconnect())
