/**
 * 从历史对话恢复 15 个号 → SQLite（主）+ enc 旁路备份
 * env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/restore-to-sqlite.mjs
 */
import { app, safeStorage } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 必须与主应用同一 userData + 同一 app 名，否则 safeStorage 解不开
const TARGET_DIR = path.join(app.getPath('appData'), 'lovemi-auto')
app.setName('Lovemi Auto')
app.setPath('userData', TARGET_DIR)
const TRANSCRIPT =
  '/Users/tangguoquan/.cursor/projects/Users-tangguoquan-Documents-PycharmProjects-LovemiAuto/agent-transcripts/ba2b86d1-109f-46df-a220-0e46fc1d456e/ba2b86d1-109f-46df-a220-0e46fc1d456e.jsonl'

function parseLine(line) {
  const parts = line.trim().split(':')
  if (parts.length < 4) return null
  return {
    email: parts[0],
    password: parts[1],
    refreshToken: parts.slice(2, -1).join(':'),
    clientId: parts[parts.length - 1],
  }
}

function extractLines(raw) {
  const by = new Map()
  for (const line of raw.split(/\r?\n/)) {
    if (!line.includes('WhitneyRippstein') && !line.includes('@hotmail.com:')) continue
    let text = line
    try {
      const obj = JSON.parse(line)
      text = ''
      for (const c of obj?.message?.content || []) {
        if (c.type === 'text') text += c.text || ''
      }
    } catch {
      /* plain */
    }
    const matches = text.match(/[A-Za-z0-9._%+-]+@hotmail\.com:[^\n\r"'\\]+/g) || []
    for (let s of matches) {
      s = s.replace(/\\n.*/, '').replace(/\\+$/, '').replace(/[,.]+$/, '')
      s = s.replace(/^[^A-Za-z0-9]+/, '').replace(/^n(?=[A-Z])/, '')
      const p = parseLine(s)
      if (p && p.clientId.length > 8 && p.refreshToken.length > 20) {
        by.set(p.email.toLowerCase(), p)
      }
    }
    if (by.size >= 15) break
  }
  return [...by.values()]
}

function encryptField(value) {
  return safeStorage.encryptString(value).toString('base64')
}

app.whenReady().then(() => {
  app.dock?.hide()
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      console.error('safeStorage unavailable')
      app.exit(3)
      return
    }
    const rows = extractLines(fs.readFileSync(TRANSCRIPT, 'utf8'))
    console.log('recovered', rows.length)
    for (const r of rows) console.log(' +', r.email)
    if (rows.length < 10) {
      console.error('too few')
      app.exit(2)
      return
    }

    const now = new Date().toISOString()
    const accounts = rows.map((p) => ({
      id: crypto.randomUUID(),
      email: p.email,
      authMode: 'oauth_graph',
      password: p.password,
      refreshToken: p.refreshToken,
      clientId: p.clientId,
      labels: [],
      status: 'idle',
      notes: 'restored-to-sqlite',
      createdAt: now,
      lovemiRegistered: true,
      lovemiRegStatus: 'registered',
      lovemiRegisteredAt: now,
    }))

    fs.mkdirSync(TARGET_DIR, { recursive: true })
    const dbFile = path.join(TARGET_DIR, 'accounts.sqlite')
    if (fs.existsSync(dbFile)) fs.copyFileSync(dbFile, `${dbFile}.pre-restore.bak`)
    // recreate clean
    for (const suffix of ['', '-wal', '-shm']) {
      const f = dbFile + suffix
      if (fs.existsSync(f)) fs.unlinkSync(f)
    }

    const db = new DatabaseSync(dbFile)
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        payload TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `)
    const upsert = db.prepare(
      `INSERT INTO accounts (id, email, payload, updated_at) VALUES (?, ?, ?, ?)`,
    )
    db.exec('BEGIN')
    try {
      for (const a of accounts) {
        upsert.run(a.id, a.email, encryptField(JSON.stringify(a)), now)
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    const n = db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n
    db.close()

    // also write enc backup (non-empty)
    const enc = path.join(TARGET_DIR, 'accounts.enc')
    fs.writeFileSync(enc, safeStorage.encryptString(JSON.stringify(accounts)))

    console.log('SQLITE', dbFile, 'count', n, 'bytes', fs.statSync(dbFile).size)
    console.log('ENC', enc, 'bytes', fs.statSync(enc).size)
    app.exit(0)
  } catch (e) {
    console.error(e)
    app.exit(1)
  }
})
