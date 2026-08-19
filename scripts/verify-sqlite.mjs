import { app, safeStorage } from 'electron'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

app.setName('lovemi-auto-restore')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto-restore-tmp'))

app.whenReady().then(() => {
  app.dock?.hide()
  const dbFile = path.join(app.getPath('appData'), 'lovemi-auto', 'accounts.sqlite')
  const db = new DatabaseSync(dbFile)
  const rows = db.prepare('SELECT email, payload FROM accounts ORDER BY email').all()
  console.log('count', rows.length)
  for (const r of rows) {
    const raw = safeStorage.decryptString(Buffer.from(r.payload, 'base64'))
    const a = JSON.parse(raw)
    console.log(a.email, a.refreshToken ? 'tok_ok' : 'tok_missing')
  }
  db.close()
  app.exit(0)
})
