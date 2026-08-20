/**
 * 合并导入 90 个中文号；剩下 10 个写到桌面 txt。
 * 用法: node scripts/run-electron-script.mjs scripts/import-zh-batch.cjs
 */
const { app, safeStorage } = require('electron')
const { randomUUID } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { DatabaseSync } = require('node:sqlite')

app.setName('Lovemi Auto')
app.setPath('userData', path.join(app.getPath('appData'), 'lovemi-auto'))

const SRC = process.env.LOVEMI_IMPORT || path.join(process.cwd(), 'secrets', 'batch-100.txt')
const TAKE = Number(process.env.LOVEMI_TAKE || 90)
const LEFTOVER = path.join(os.homedir(), 'Desktop', '未导入账号-10.txt')

function parseLine(line) {
  const parts = line.trim().split(':')
  if (parts.length < 4) return null
  const email = parts[0]?.trim()
  if (!email?.includes('@')) return null
  const password = parts[1]
  const clientId = parts[parts.length - 1]
  let tokenStart = 2
  let recovery = ''
  if (parts.length >= 5 && parts[2]?.includes('@') && !/^M\./i.test(parts[2])) {
    recovery = parts[2]
    tokenStart = 3
  }
  const refreshToken = parts.slice(tokenStart, -1).join(':')
  if (!refreshToken || clientId.length < 8) return null
  return { email, password, recovery, refreshToken, clientId }
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
    if (!fs.existsSync(SRC)) {
      console.log(JSON.stringify({ ok: false, error: `missing ${SRC}` }))
      app.exit(1)
      return
    }
    const parsed = fs
      .readFileSync(SRC, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map(parseLine)
      .filter(Boolean)
    if (parsed.length < TAKE) {
      console.log(JSON.stringify({ ok: false, error: `parsed ${parsed.length} < ${TAKE}` }))
      app.exit(1)
      return
    }
    const keep = parsed.slice(0, TAKE)
    const rest = parsed.slice(TAKE)
    fs.mkdirSync(path.dirname(LEFTOVER), { recursive: true })
    const restLines = rest.map((p) =>
      [p.email, p.password, p.recovery, p.refreshToken, p.clientId].filter(Boolean).join(':'),
    )
    fs.writeFileSync(LEFTOVER, restLines.join('\n') + (restLines.length ? '\n' : ''), 'utf8')

    const dbPath = path.join(app.getPath('userData'), 'accounts.sqlite')
    const db = new DatabaseSync(dbPath)
    db.exec('PRAGMA journal_mode = WAL;')
    const existing = db
      .prepare('SELECT payload FROM accounts')
      .all()
      .map((r) => JSON.parse(dec(r.payload)))
    const byEmail = new Map(existing.map((a) => [String(a.email).toLowerCase(), a]))
    const now = new Date().toISOString()
    let fresh = 0
    let updated = 0
    for (const r of keep) {
      const key = r.email.toLowerCase()
      const prev = byEmail.get(key)
      if (prev) {
        byEmail.set(key, {
          ...prev,
          password: r.password,
          refreshToken: r.refreshToken,
          clientId: r.clientId,
          authMode: 'oauth_graph',
          lovemiLocale: 'zh',
          notes: r.recovery
            ? `imported-zh-90 · recovery: ${r.recovery}`
            : prev.notes || 'imported-zh-90',
        })
        updated++
        continue
      }
      byEmail.set(key, {
        id: randomUUID(),
        email: r.email,
        authMode: 'oauth_graph',
        password: r.password,
        refreshToken: r.refreshToken,
        clientId: r.clientId,
        labels: ['zh-90'],
        status: 'ready',
        notes: r.recovery ? `imported-zh-90 · recovery: ${r.recovery}` : 'imported-zh-90',
        createdAt: now,
        lovemiRegistered: false,
        lovemiRegStatus: 'none',
        lovemiLocale: 'zh',
      })
      fresh++
    }
    const merged = [...byEmail.values()]
    const upsert = db.prepare(`
      INSERT INTO accounts (id, email, payload, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        email = excluded.email,
        payload = excluded.payload,
        updated_at = excluded.updated_at
    `)
    db.exec('BEGIN')
    try {
      for (const a of merged) upsert.run(a.id, a.email, enc(JSON.stringify(a)), now)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
    const n = db.prepare('SELECT COUNT(*) AS n FROM accounts').get().n
    db.close()
    console.log(
      JSON.stringify({
        ok: true,
        parsed: parsed.length,
        imported: keep.length,
        leftover: rest.length,
        leftoverFile: LEFTOVER,
        fresh,
        updated,
        total: n,
        locale: 'zh',
      }),
    )
    app.exit(0)
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: String(e?.message || e) }))
    app.exit(1)
  }
})
