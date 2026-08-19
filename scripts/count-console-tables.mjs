import { app } from 'electron'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

app.setName('Lovemi Auto')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto'))

app.whenReady().then(() => {
  app.dock?.hide()
  const db = new DatabaseSync(path.join(app.getPath('userData'), 'accounts.sqlite'))
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all()
  const count = (t) => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()).n)
  const out = { tables: tables.map((t) => t.name) }
  for (const t of [
    'comment_templates',
    'display_name_pool',
    'characters',
    'account_character_actions',
    'console_logs',
  ]) {
    try {
      out[t] = count(t)
    } catch (e) {
      out[t] = String(e.message || e)
    }
  }
  const by = db
    .prepare(`SELECT locale, COUNT(*) AS n FROM comment_templates GROUP BY locale ORDER BY locale`)
    .all()
  out.commentsByLocale = by
  console.log(JSON.stringify(out, null, 2))
  db.close()
  app.exit(0)
})
