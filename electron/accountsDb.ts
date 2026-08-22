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

function clearedMarkerPath() {
  return path.join(app.getPath('userData'), 'accounts.cleared')
}

function isAccountsClearedMarker() {
  return fs.existsSync(clearedMarkerPath())
}

function setAccountsClearedMarker() {
  fs.writeFileSync(clearedMarkerPath(), new Date().toISOString(), 'utf8')
}

function clearAccountsClearedMarker() {
  try {
    fs.unlinkSync(clearedMarkerPath())
  } catch {
    /* ignore */
  }
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
    CREATE INDEX IF NOT EXISTS idx_actions_liked_at ON account_character_actions(liked_at);
    CREATE INDEX IF NOT EXISTS idx_actions_commented_at ON account_character_actions(commented_at);

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

    -- 创建角色 UI/队列状态不再依赖 localStorage。
    CREATE TABLE IF NOT EXISTS create_char_ui_state (
      id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS create_char_reference_images (
      slot INTEGER PRIMARY KEY CHECK(slot BETWEEN 1 AND 5),
      mime_type TEXT NOT NULL,
      image_data BLOB,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS create_char_runs (
      run_id TEXT PRIMARY KEY,
      slot INTEGER NOT NULL,
      epoch INTEGER NOT NULL,
      status TEXT NOT NULL,
      stage TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_create_char_runs_status
      ON create_char_runs(status, updated_at DESC);
  `)
  migrateConsoleSchema(db)
  return db
}

function migrateConsoleSchema(database: DatabaseSync) {
  const charCols = database.prepare(`PRAGMA table_info(characters)`).all() as Array<{ name: string }>
  if (!charCols.some((c) => c.name === 'listing_kind')) {
    database.exec(`ALTER TABLE characters ADD COLUMN listing_kind TEXT NOT NULL DEFAULT 'character'`)
  }
  if (!charCols.some((c) => c.name === 'feed')) {
    database.exec(`ALTER TABLE characters ADD COLUMN feed TEXT NOT NULL DEFAULT ''`)
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

/** 单条 upsert（真实注册入库） */
export function upsertAccount(account: StoredAccount): { ok: boolean; error?: string } {
  const raw = loadAccountsJson()
  let accounts: StoredAccount[] = []
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (Array.isArray(parsed)) accounts = parsed as StoredAccount[]
    } catch {
      accounts = []
    }
  }
  const email = String(account.email).toLowerCase()
  const idx = accounts.findIndex((a) => String(a.email || '').toLowerCase() === email)
  if (idx >= 0) {
    accounts[idx] = { ...accounts[idx], ...account, id: accounts[idx]!.id || account.id }
  } else {
    accounts.push(account)
  }
  const result = saveAccountsJson(JSON.stringify(accounts))
  return result.ok ? { ok: true } : { ok: false, error: result.error }
}

/** 强制清空邮箱库存（绕过 saveAccountsJson 的空库存保护） */
export function clearAllAccounts(): { ok: boolean; error?: string; cleared?: number } {
  const database = openDb()
  const prevN = countAccounts()
  database.exec('BEGIN')
  try {
    database.exec('DELETE FROM accounts')
    database.exec('COMMIT')
  } catch (err) {
    try {
      database.exec('ROLLBACK')
    } catch {
      /* ignore */
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  try {
    database.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  } catch {
    /* ignore */
  }
  try {
    writeEncBackup('[]')
    const enc = encPath()
    if (fs.existsSync(`${enc}.bak`)) fs.unlinkSync(`${enc}.bak`)
  } catch {
    /* 主库已清空，旁路备份失败不阻断 */
  }
  setAccountsClearedMarker()
  return { ok: true, cleared: prevN }
}

export function loadAccountsJson(): string | null {
  const rows = openDb().prepare('SELECT payload FROM accounts ORDER BY email COLLATE NOCASE').all() as Array<{
    payload: string
  }>
  if (!rows.length) {
    // 用户主动清空后，禁止从 enc / 仓库备份自动恢复
    if (isAccountsClearedMarker()) return null
    // 首次：本机 enc → 仓库 backups/ 明文（Mac→Windows 换机时 enc 解不开）
    const migrated = migrateFromEncIfNeeded()
    if (migrated !== null) return migrated
    const fromRepo = migrateFromRepoBackupIfNeeded()
    if (fromRepo !== null) return fromRepo
    return null
  }
  const accounts: unknown[] = []
  for (const r of rows) {
    try {
      accounts.push(JSON.parse(decryptField(r.payload)))
    } catch {
      /* 单条损坏不拖垮整库 */
    }
  }
  if (!accounts.length) return null
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
    clearAccountsClearedMarker()
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

function repoBackupRoots(): string[] {
  return [...new Set([process.cwd(), app.getAppPath(), path.join(app.getAppPath(), '..')])]
}

function findRepoAccountBackup(): string | null {
  const files: string[] = []
  for (const root of repoBackupRoots()) {
    const dir = path.join(root, 'backups')
    if (!fs.existsSync(dir)) continue
    for (const name of fs.readdirSync(dir)) {
      if (/^accounts-.*\.(array\.)?json$/i.test(name)) {
        files.push(path.join(dir, name))
      }
    }
  }
  files.sort((a, b) => {
    const preferA = a.endsWith('.array.json') ? 1 : 0
    const preferB = b.endsWith('.array.json') ? 1 : 0
    if (preferA !== preferB) return preferB - preferA
    return path.basename(b).localeCompare(path.basename(a))
  })
  return files[0] || null
}

function parseBackupAccounts(raw: string): unknown[] | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) return parsed
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { accounts?: unknown }).accounts)) {
      return (parsed as { accounts: unknown[] }).accounts
    }
  } catch {
    /* ignore */
  }
  return null
}

/** 空库时从私有仓库 backups/ 导入明文库存（Windows 无法解密 macOS accounts.enc） */
function migrateFromRepoBackupIfNeeded(): string | null {
  const file = findRepoAccountBackup()
  if (!file) return null
  try {
    const accounts = parseBackupAccounts(fs.readFileSync(file, 'utf8'))
    if (!accounts || accounts.length === 0) return null
    const plaintext = JSON.stringify(accounts)
    const result = saveAccountsJson(plaintext)
    if (!result.ok) return null
    console.log(`[accounts] imported ${accounts.length} from ${path.basename(file)}`)
    return plaintext
  } catch (err) {
    console.error('[accounts] repo backup import failed', err)
    return null
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
