/**
 * Reset accounts failed with "already registered" so register queue can reclaim them.
 */
import { app, safeStorage } from 'electron'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

app.setName('Lovemi Auto')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto'))

const ALREADY = /already\s*registered|already\s*exists|isalready|email isalready|已注册/i

app.whenReady().then(() => {
  app.dock?.hide()
  const db = new DatabaseSync(path.join(app.getPath('userData'), 'accounts.sqlite'))
  const upsert = db.prepare(`UPDATE accounts SET payload = ?, updated_at = ? WHERE id = ?`)
  let reset = 0
  const locals = []
  for (const r of db.prepare('SELECT id, payload FROM accounts').all()) {
    const a = JSON.parse(safeStorage.decryptString(Buffer.from(r.payload, 'base64')))
    if (a.lovemiRegistered || a.lovemiRegStatus === 'registered') continue
    const err = String(a.lovemiRegError || a.lastError || '')
    if (!ALREADY.test(err)) continue
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
    locals.push(String(a.email).split('@')[0])
  }
  console.log(JSON.stringify({ ok: true, reset, locals: locals.slice(0, 30), more: Math.max(0, locals.length - 30) }))
  db.close()
  app.exit(0)
})
