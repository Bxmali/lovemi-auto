/**
 * Reset retryable failed regs; leave hard JWT failures alone.
 * Does not print secrets.
 */
import { app, safeStorage } from 'electron'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

app.setName('Lovemi Auto')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto'))

const HARD = /JWT is not well formed|IDX14100/i

app.whenReady().then(() => {
  app.dock?.hide()
  const db = new DatabaseSync(path.join(app.getPath('userData'), 'accounts.sqlite'))
  const rows = db.prepare('SELECT id, email, payload FROM accounts').all()
  const upsert = db.prepare(
    `UPDATE accounts SET payload = ?, updated_at = ? WHERE id = ?`,
  )
  let reset = 0
  let skippedHard = 0
  let pendingNone = 0
  const resetLocals = []
  for (const r of rows) {
    const a = JSON.parse(safeStorage.decryptString(Buffer.from(r.payload, 'base64')))
    const isOrder =
      (a.labels || []).includes('order8652192') || String(a.notes || '').includes('order8652192')
    if (!isOrder) continue
    if (a.lovemiRegistered || a.lovemiRegStatus === 'registered') continue
    if (a.lovemiRegStatus === 'none' || !a.lovemiRegStatus) {
      pendingNone++
      continue
    }
    if (a.lovemiRegStatus === 'failed') {
      const err = String(a.lovemiRegError || a.lastError || '')
      if (HARD.test(err)) {
        skippedHard++
        continue
      }
      a.lovemiRegStatus = 'none'
      a.lovemiRegError = undefined
      a.lastError = undefined
      a.status = 'ready'
      upsert.run(
        safeStorage.encryptString(JSON.stringify(a)).toString('base64'),
        new Date().toISOString(),
        a.id,
      )
      reset++
      resetLocals.push(String(a.email).split('@')[0])
    }
  }
  console.log(
    JSON.stringify({
      ok: true,
      resetSoftFails: reset,
      resetLocals,
      stillNone: pendingNone,
      skippedHardJwt: skippedHard,
    }),
  )
  db.close()
  app.exit(0)
})
