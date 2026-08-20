/**
 * 导出本机账号到 backups/（明文 JSON，仅用于私有仓库备份）
 * 必须与主进程同名：app.setName('Lovemi Auto')，否则 safeStorage 解不开。
 * 用法: env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/export-accounts-backup.cjs
 */
const { app, safeStorage } = require('electron')
const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')

app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto'))
app.setName('Lovemi Auto')

app.whenReady().then(() => {
  const userData = app.getPath('userData')
  const encPath = path.join(userData, 'accounts.enc')
  const sqlitePath = path.join(userData, 'accounts.sqlite')
  let accounts = []

  if (fs.existsSync(sqlitePath)) {
    const db = new DatabaseSync(sqlitePath, { readOnly: true })
    const rows = db.prepare('SELECT payload FROM accounts ORDER BY email COLLATE NOCASE').all()
    for (const row of rows) {
      const plain = safeStorage.decryptString(Buffer.from(String(row.payload), 'base64'))
      accounts.push(JSON.parse(plain))
    }
    db.close()
  }

  if (!accounts.length && fs.existsSync(encPath)) {
    const raw = safeStorage.decryptString(fs.readFileSync(encPath))
    accounts = JSON.parse(raw)
  }

  if (!Array.isArray(accounts) || !accounts.length) {
    console.error(JSON.stringify({ ok: false, error: 'no accounts' }))
    app.exit(1)
    return
  }

  const outDir = path.join(process.cwd(), 'backups')
  fs.mkdirSync(outDir, { recursive: true })
  const stamp = new Date().toISOString().slice(0, 10)
  const outFile = path.join(outDir, `accounts-${stamp}.json`)
  const arrayFile = path.join(outDir, `accounts-${stamp}.array.json`)
  const meta = {
    exportedAt: new Date().toISOString(),
    count: accounts.length,
    source: fs.existsSync(sqlitePath) ? 'accounts.sqlite' : 'accounts.enc',
    note: 'PRIVATE repo backup. Contains refresh tokens / Lovemi Bearers.',
  }
  fs.writeFileSync(outFile, JSON.stringify({ meta, accounts }, null, 2), 'utf8')
  fs.writeFileSync(arrayFile, JSON.stringify(accounts, null, 2), 'utf8')
  if (fs.existsSync(encPath)) {
    fs.copyFileSync(encPath, path.join(outDir, `accounts-${stamp}.enc`))
  }
  console.log(
    JSON.stringify({
      ok: true,
      count: accounts.length,
      outFile,
      arrayFile,
      hasRefresh: accounts.filter((a) => a.refreshToken).length,
      hasBearer: accounts.filter((a) => a.lovemiSessionToken).length,
    }),
  )
  app.exit(0)
})
