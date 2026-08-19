import fs from 'node:fs'
import path from 'node:path'
import { app, safeStorage } from 'electron'
import { DatabaseSync } from 'node:sqlite'

export type StoredAccount = Record<string, unknown> & {
  id: string
  email: string
}

let db: DatabaseSync | null = null

function dbPath() {
  return path.join(app.getPath('userData'), 'accounts.sqlite')
}

function encPath() {
  return path.join(app.getPath('userData'), 'accounts.enc')
}

/** 同库多表：账号 + 控制台去重/文案/日志 */
export function openAccountsDb() {
  if (db) return db
  const file = dbPath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  db = new DatabaseSync(file)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS accounts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_accounts_email ON accounts(email);

    CREATE TABLE IF NOT EXISTS characters (
      listing_id TEXT PRIMARY KEY,
      asset_id TEXT NOT NULL,
      title TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      raw_json TEXT
    );

    CREATE TABLE IF NOT EXISTS account_character_actions (
      account_id TEXT NOT NULL,
      listing_id TEXT NOT NULL,
      asset_id TEXT,
      decision TEXT NOT NULL,
      liked_at TEXT,
      commented_at TEXT,
      comment_id TEXT,
      comment_text TEXT,
      skip_reason TEXT,
      fail_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (account_id, listing_id)
    );
    CREATE INDEX IF NOT EXISTS idx_actions_decision ON account_character_actions(decision);
    CREATE INDEX IF NOT EXISTS idx_actions_pending ON account_character_actions(decision, updated_at);

    CREATE TABLE IF NOT EXISTS comment_templates (
      id TEXT PRIMARY KEY,
      locale TEXT NOT NULL,
      body TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      use_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_comments_locale ON comment_templates(locale, enabled);

    CREATE TABLE IF NOT EXISTS display_name_pool (
      id TEXT PRIMARY KEY,
      locale TEXT NOT NULL,
      name TEXT NOT NULL,
      normalized TEXT NOT NULL UNIQUE,
      used_by_account_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_names_locale_free ON display_name_pool(locale, used_by_account_id);

    CREATE TABLE IF NOT EXISTS console_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      level TEXT NOT NULL,
      account_email TEXT,
      listing_id TEXT,
      action TEXT NOT NULL,
      message TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_console_logs_ts ON console_logs(ts DESC);
  `)
  migrateConsoleSchema(db)
  return db
}

function migrateConsoleSchema(database: DatabaseSync) {
  const charCols = database.prepare(`PRAGMA table_info(characters)`).all() as Array<{ name: string }>
  if (!charCols.some((c) => c.name === 'listing_kind')) {
    database.exec(`ALTER TABLE characters ADD COLUMN listing_kind TEXT NOT NULL DEFAULT 'character'`)
  }
  const cmtCols = database.prepare(`PRAGMA table_info(comment_templates)`).all() as Array<{ name: string }>
  if (!cmtCols.some((c) => c.name === 'surface')) {
    database.exec(`ALTER TABLE comment_templates ADD COLUMN surface TEXT NOT NULL DEFAULT 'character'`)
  }
  database.exec(
    `CREATE INDEX IF NOT EXISTS idx_comments_surface_locale ON comment_templates(surface, locale, enabled)`,
  )
}

function openDb() {
  return openAccountsDb()
}

function encryptField(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) return value
  return safeStorage.encryptString(value).toString('base64')
}

function decryptField(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) return value
  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'))
  } catch {
    try {
      // 偶发直接存了 Buffer 的 latin1/utf8
      return safeStorage.decryptString(Buffer.from(value, 'utf8'))
    } catch {
      return value
    }
  }
}

export function countAccounts(): number {
  const row = openDb().prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }
  return Number(row?.n || 0)
}

export function loadAccountsJson(): string | null {
  const rows = openDb().prepare('SELECT payload FROM accounts ORDER BY email COLLATE NOCASE').all() as Array<{
    payload: string
  }>
  if (!rows.length) {
    // 首次：尝试从 accounts.enc 迁移
    const migrated = migrateFromEncIfNeeded()
    if (migrated === null) return null
    return migrated
  }
  const accounts = rows.map((r) => JSON.parse(decryptField(r.payload)))
  return JSON.stringify(accounts)
}

export function saveAccountsJson(plaintext: string): {
  ok: boolean
  encrypted: boolean
  error?: string
  count?: number
} {
  let next: StoredAccount[]
  try {
    const parsed = JSON.parse(plaintext) as unknown
    if (!Array.isArray(parsed)) return { ok: false, encrypted: true, error: '库存格式无效' }
    next = parsed.filter((a) => a && typeof a === 'object' && (a as StoredAccount).email) as StoredAccount[]
  } catch {
    return { ok: false, encrypted: true, error: '库存 JSON 解析失败' }
  }

  const database = openDb()
  const prevN = countAccounts()
  const nextN = next.length

  if (prevN > 0 && nextN === 0) {
    return { ok: false, encrypted: true, error: `拒绝空库存覆盖（原有 ${prevN} 条）` }
  }
  if (prevN >= 5 && nextN > 0 && nextN < Math.max(2, Math.floor(prevN * 0.4))) {
    return { ok: false, encrypted: true, error: `拒绝缩水落盘 ${nextN}/${prevN}` }
  }

  const now = new Date().toISOString()
  const upsert = database.prepare(`
    INSERT INTO accounts (id, email, payload, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      email = excluded.email,
      payload = excluded.payload,
      updated_at = excluded.updated_at
  `)
  const keepIds = next.map((a) => String(a.id))

  database.exec('BEGIN')
  try {
    for (const a of next) {
      const id = String(a.id)
      const email = String(a.email)
      upsert.run(id, email, encryptField(JSON.stringify(a)), now)
    }
    if (keepIds.length) {
      const placeholders = keepIds.map(() => '?').join(',')
      database.prepare(`DELETE FROM accounts WHERE id NOT IN (${placeholders})`).run(...keepIds)
    }
    database.exec('COMMIT')
  } catch (err) {
    database.exec('ROLLBACK')
    throw err
  }

  // 旁路备份一份 enc（失败不影响主存储）
  try {
    writeEncBackup(plaintext)
  } catch {
    /* ignore */
  }

  return { ok: true, encrypted: safeStorage.isEncryptionAvailable(), count: nextN }
}

function writeEncBackup(plaintext: string) {
  const file = encPath()
  if (safeStorage.isEncryptionAvailable()) {
    if (fs.existsSync(file) && fs.statSync(file).size > 64) {
      fs.copyFileSync(file, `${file}.bak`)
    }
    fs.writeFileSync(file, safeStorage.encryptString(plaintext))
  } else {
    fs.writeFileSync(file, plaintext, 'utf8')
  }
}

/** 若 SQLite 空且 enc 有数据，迁入一次 */
function migrateFromEncIfNeeded(): string | null {
  const file = encPath()
  if (!fs.existsSync(file) || fs.statSync(file).size < 64) return null
  try {
    const raw = safeStorage.isEncryptionAvailable()
      ? safeStorage.decryptString(fs.readFileSync(file))
      : fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed) || parsed.length === 0) return null
    const result = saveAccountsJson(raw)
    if (!result.ok) return null
    return raw
  } catch {
    return null
  }
}

export function closeAccountsDb() {
  try {
    db?.close()
  } catch {
    /* ignore */
  }
  db = null
}
