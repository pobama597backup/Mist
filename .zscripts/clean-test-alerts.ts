import { db } from '../src/lib/db'
async function main() {
  // test-suite residue: every 'Approval needed' system alert from the
  // bun-test approval fixtures (CANCELP, dial proof, revoke l…) — all
  // delivered history rows referencing approvals that no longer exist.
  const deleted = await db.alert.deleteMany({
    where: { kind: 'system', status: 'delivered', title: { startsWith: '❔ Approval needed' } },
  })
  console.log('deleted test-residue alerts:', deleted.count)
  const remaining = await db.alert.count()
  console.log('remaining alerts:', remaining)
  await db.$disconnect()
}
void main()
