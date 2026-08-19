/**
 * 仅合并导入订单账号到 accounts.sqlite（不打印密钥）
 * 随后由 App 启动探活/注册/改名队列接手。
 *
 * LOVEMI_IMPORT=/path/to/order.txt env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/bootstrap-import.mjs
 */
import { app, safeStorage } from 'electron'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'

app.setName('Lovemi Auto')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto'))

const IMPORT = process.env.LOVEMI_IMPORT || ''
const LABEL = process.env.LOVEMI_LABEL || 'order8652192'
const STATUS = path.join(app.getPath('userData'), 'bootstrap-status.json')

function parseLines(raw) {
  const accounts = []
  let bad = 0
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const parts = trimmed.split(':')
    if (parts.length < 4) {
      bad++
      continue
    }
    const email = parts[0]?.trim()
    if (!email?.includes('@')) {
      bad++
      continue
    }
    accounts.push({
      email,
      password: parts[1],
      refreshToken: parts.slice(2, -1).join(':'),
      clientId: parts[parts.length - 1],
    })
  }
  return { accounts, bad }
}

function enc(s) {
  return safeStorage.encryptString(s).toString('base64')
}

function dec(s) {
  return safeStorage.decryptString(Buffer.from(s, 'base64'))
}

app.whenReady().then(() => {
  app.dock?.hide()
  try {
    if (!IMPORT || !fs.existsSync(IMPORT)) {
      console.log(JSON.stringify({ ok: false, error: 'missing LOVEMI_IMPORT' }))
      app.exit(1)
      return
    }
    const { accounts: rows, bad } = parseLines(fs.readFileSync(IMPORT, 'utf8'))
    const dbPath = path.join(app.getPath('userData'), 'accounts.sqlite')
    const db = new DatabaseSync(dbPath)
    db.exec('PRAGMA journal_mode = WAL;')
    const existing = db
      .prepare('SELECT payload FROM accounts')
      .all()
      .map((r) => JSON.parse(dec(r.payload)))
    const byEmail = new Map(existing.map((a) => [String(a.email).toLowerCase(), a]))
    let fresh = 0
    for (const r of rows) {
      const key = r.email.toLowerCase()
      if (byEmail.has(key)) continue
      byEmail.set(key, {
        id: randomUUID(),
        email: r.email,
        authMode: 'oauth_graph',
        password: r.password,
        refreshToken: r.refreshToken,
        clientId: r.clientId,
        labels: [LABEL],
        status: 'ready',
        notes: `imported ${LABEL}`,
        createdAt: new Date().toISOString(),
        lovemiRegistered: false,
        lovemiRegStatus: 'none',
      })
      fresh++
    }
    const merged = [...byEmail.values()]
    if (merged.length < existing.length) throw new Error('merge shrunk stock')
    const now = new Date().toISOString()
    const upsert = db.prepare(`
      INSERT INTO accounts (id, email, payload, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        email = excluded.email,
        payload = excluded.payload,
        updated_at = excluded.updated_at
    `)
    const keep = new Set(merged.map((a) => a.id))
    db.exec('BEGIN')
    try {
      for (const a of merged) upsert.run(a.id, a.email, enc(JSON.stringify(a)), now)
      for (const r of db.prepare('SELECT id FROM accounts').all()) {
        if (!keep.has(r.id)) db.prepare('DELETE FROM accounts WHERE id = ?').run(r.id)
      }
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    db.close()
    const summary = {
      ok: true,
      phase: 'merged',
      parsed: rows.length,
      badLines: bad,
      fresh,
      total: merged.length,
      label: LABEL,
    }
    fs.writeFileSync(STATUS, JSON.stringify({ ...summary, updatedAt: new Date().toISOString() }, null, 2))
    console.log(JSON.stringify(summary))
    app.exit(0)
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: String(e?.message || e) }))
    app.exit(1)
  }
})
