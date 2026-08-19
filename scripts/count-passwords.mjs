import { app, safeStorage } from 'electron'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

app.setName('Lovemi Auto')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto'))

app.whenReady().then(() => {
  app.dock?.hide()
  const db = new DatabaseSync(path.join(app.getPath('userData'), 'accounts.sqlite'))
  const rows = db.prepare('SELECT email, payload FROM accounts').all()
  let pw = 0
  let tok = 0
  for (const r of rows) {
    const a = JSON.parse(safeStorage.decryptString(Buffer.from(r.payload, 'base64')))
    if (a.lovemiPassword) pw++
    if (a.lovemiSessionToken) tok++
  }
  console.log(`accounts=${rows.length} password=${pw} bearer=${tok}`)
  db.close()
  app.exit(0)
})
