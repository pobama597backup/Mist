import { db } from '../src/lib/db'
async function main() {
  const id = process.argv[2]
  const m = await db.mission.findUnique({ where: { id }, select: { status: true, stepsUsed: true, maxSteps: true, result: true, error: true, updatedAt: true } })
  if (!m) return console.log('not found')
  console.log(`${m.status} | steps ${m.stepsUsed}/${m.maxSteps} | updated ${m.updatedAt.toISOString()}`)
  if (m.error) console.log('ERROR:', String(m.error).slice(0, 300))
  if (m.result) console.log('RESULT:', String(m.result).slice(0, 400))
}
main().finally(() => db.$disconnect())
