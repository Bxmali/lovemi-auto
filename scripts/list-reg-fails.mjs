/**
 * List Lovemi register failures / unfinished (no secrets printed).
 */
import { app, safeStorage } from 'electron'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

app.setName('Lovemi Auto')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto'))

app.whenReady().then(() => {
  app.dock?.hide()
  const db = new DatabaseSync(path.join(app.getPath('userData'), 'accounts.sqlite'))
  const fails = []
  const unfinished = []
  let registered = 0
  let withToken = 0
  let total = 0
  for (const r of db.prepare('SELECT payload FROM accounts').all()) {
    let a
    try {
      a = JSON.parse(safeStorage.decryptString(Buffer.from(r.payload, 'base64')))
    } catch {
      continue
    }
    total++
    const st = a.lovemiRegStatus || 'none'
    if (a.lovemiRegistered || st === 'registered') {
      registered++
      if (a.lovemiSessionToken) withToken++
      continue
    }
    const item = {
      local: String(a.email || '').split('@')[0],
      status: st,
      accountStatus: a.status,
      err: String(a.lovemiRegError || a.lastError || '').slice(0, 180),
      hasRT: Boolean(a.refreshToken && a.clientId),
      order: (a.labels || []).includes('order8652192'),
    }
    if (st === 'failed' || a.lovemiRegError) fails.push(item)
    else unfinished.push(item)
  }
  console.log(
    JSON.stringify(
      {
        total,
        registered,
        withToken,
        failCount: fails.length,
        unfinishedCount: unfinished.length,
        fails,
        unfinished,
      },
      null,
      2,
    ),
  )
  db.close()
  app.exit(0)
})
