import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { loadAccountsJson } from './accountsDb'

export type PoolEmail = {
  email: string
  password?: string
  refreshToken?: string
  clientId?: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function defaultEmailPoolPath() {
  return path.join(app.getPath('home'), 'Downloads', 'EmailReal.txt')
}

function usedEmailsPath() {
  return path.join(app.getPath('userData'), 'real-register-used-emails.json')
}

function loadUsedEmails(): Set<string> {
  const out = new Set<string>()
  try {
    const file = usedEmailsPath()
    if (!fs.existsSync(file)) return out
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
    if (Array.isArray(parsed)) {
      for (const e of parsed) out.add(String(e).toLowerCase())
    }
  } catch {
    /* ignore */
  }
  return out
}

function loadInventoryEmails(): Set<string> {
  const out = new Set<string>()
  try {
    const raw = loadAccountsJson()
    if (!raw) return out
    const accounts = JSON.parse(raw) as Array<{ email?: string }>
    if (!Array.isArray(accounts)) return out
    for (const a of accounts) {
      const email = String(a.email || '').trim().toLowerCase()
      if (email) out.add(email)
    }
  } catch {
    /* ignore */
  }
  return out
}

export function collectExcludedEmails(): Set<string> {
  const excluded = loadUsedEmails()
  for (const e of loadInventoryEmails()) excluded.add(e)
  return excluded
}

export function markRealRegisterEmailUsed(email: string) {
  const key = email.trim().toLowerCase()
  if (!key) return
  const used = loadUsedEmails()
  used.add(key)
  fs.mkdirSync(path.dirname(usedEmailsPath()), { recursive: true })
  fs.writeFileSync(usedEmailsPath(), JSON.stringify([...used], null, 2), 'utf8')
}

function parsePoolLine(trimmed: string): PoolEmail | null {
  const parts = trimmed.split(':')
  if (parts.length < 4) return null
  const email = parts[0]?.trim().toLowerCase()
  if (!email?.includes('@')) return null
  const password = parts[1]?.trim() || ''

  // EmailReal.txt：email:pass:client_id:refresh_token（client_id 在第 3 段）
  const third = parts[2]?.trim() || ''
  if (UUID_RE.test(third)) {
    const refreshToken = parts.slice(3).join(':').trim()
    if (!refreshToken) return null
    return { email, password, refreshToken, clientId: third }
  }

  // 通用：email:pass:refresh_token:client_id（末段 UUID）
  let clientId = parts[parts.length - 1]?.trim() || ''
  let tokenStart = 2
  if (parts.length >= 5 && parts[2]?.includes('@') && !/^M\./i.test(parts[2] || '')) {
    tokenStart = 3
  }
  let refreshToken = parts.slice(tokenStart, -1).join(':').trim()

  if (!UUID_RE.test(clientId) && UUID_RE.test(parts[parts.length - 2]?.trim() || '')) {
    clientId = parts[parts.length - 2]!.trim()
    refreshToken = parts
      .slice(tokenStart, -2)
      .concat(parts[parts.length - 1] || '')
      .join(':')
      .trim()
  } else if (UUID_RE.test(refreshToken) && !UUID_RE.test(clientId) && clientId.length > 40) {
    const tmp = clientId
    clientId = refreshToken
    refreshToken = tmp
  }

  if (!UUID_RE.test(clientId) || !refreshToken) return null
  return { email, password, refreshToken, clientId }
}

function parsePoolLines(raw: string): { accounts: PoolEmail[]; badLines: number } {
  const accounts: PoolEmail[] = []
  let badLines = 0
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^\uFEFF/, '')
    if (!trimmed || trimmed.startsWith('#')) continue
    const row = parsePoolLine(trimmed)
    if (!row) {
      badLines++
      continue
    }
    accounts.push(row)
  }
  return { accounts, badLines }
}

export function loadRealRegisterEmailPool(customPath?: string): {
  ok: boolean
  path: string
  accounts: PoolEmail[]
  total: number
  excluded: number
  available: number
  badLines: number
  error?: string
} {
  const file = (customPath || '').trim() || defaultEmailPoolPath()
  if (!fs.existsSync(file)) {
    return {
      ok: false,
      path: file,
      accounts: [],
      total: 0,
      excluded: 0,
      available: 0,
      badLines: 0,
      error: `邮箱池文件不存在: ${file}`,
    }
  }
  try {
    const { accounts, badLines } = parsePoolLines(fs.readFileSync(file, 'utf8'))
    if (!accounts.length) {
      return {
        ok: false,
        path: file,
        accounts: [],
        total: 0,
        excluded: 0,
        available: 0,
        badLines,
        error:
          badLines > 0
            ? `解析失败 ${badLines} 行（格式应为 email:pass:client_id:refresh_token）`
            : '邮箱池文件为空',
      }
    }
    const excludedSet = collectExcludedEmails()
    const availableAccounts = accounts.filter((a) => !excludedSet.has(a.email))
    return {
      ok: true,
      path: file,
      accounts: availableAccounts,
      total: accounts.length,
      excluded: accounts.length - availableAccounts.length,
      available: availableAccounts.length,
      badLines,
    }
  } catch (err) {
    return {
      ok: false,
      path: file,
      accounts: [],
      total: 0,
      excluded: 0,
      available: 0,
      badLines: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
