/**
 * Soft-reset a single register fail so queue can reclaim (preferReclaim via already-err hint).
 */
import { app, safeStorage } from 'electron'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

app.setName('Lovemi Auto')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto'))

const TARGET = (process.env.LOVEMI_LOCAL || 'AaravSuthar4513').toLowerCase()

app.whenReady().then(() => {
  app.dock?.hide()
  const db = new DatabaseSync(path.join(app.getPath('userData'), 'accounts.sqlite'))
  const upsert = db.prepare(`UPDATE accounts SET payload = ?, updated_at = ? WHERE id = ?`)
  let hit = null
  for (const r of db.prepare('SELECT id, payload FROM accounts').all()) {
    const a = JSON.parse(safeStorage.decryptString(Buffer.from(r.payload, 'base64')))
    const local = String(a.email || '').split('@')[0].toLowerCase()
    if (local !== TARGET) continue
    a.lovemiRegStatus = 'none'
    a.lovemiRegistered = false
    // hint register queue → preferReclaim (skip register OTP)
    a.lovemiRegError = 'email is already registered'
    a.lastError = undefined
    a.status = 'ready'
    upsert.run(
      safeStorage.encryptString(JSON.stringify(a)).toString('base64'),
      new Date().toISOString(),
      a.id,
    )
    hit = { id: a.id, local: String(a.email).split('@')[0], prev: 'rate-limited challenge' }
    break
  }
  console.log(JSON.stringify({ ok: Boolean(hit), hit }))
  db.close()
  app.exit(hit ? 0 : 1)
})
