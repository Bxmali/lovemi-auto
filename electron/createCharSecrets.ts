import fs from 'node:fs'
import path from 'node:path'
import { app, safeStorage } from 'electron'

export type CreateCharSecrets = {
  teamoApiBase: string
  teamoApiKey: string
  teamoModel: string
  /** 管理员 Lovemi Bearer（仅本地加密存储） */
  adminSessionToken?: string
  adminEmailLocal?: string
  adminAccountId?: string
}

const DEFAULTS: CreateCharSecrets = {
  teamoApiBase: 'https://api.teamorouter.com/v1',
  teamoApiKey: '',
  teamoModel: 'gpt-5.4-mini',
}

function secretsPath() {
  return path.join(app.getPath('userData'), 'create-char.secrets')
}

export function loadCreateCharSecrets(): CreateCharSecrets {
  try {
    const file = secretsPath()
    if (!fs.existsSync(file)) return { ...DEFAULTS }
    const raw = fs.readFileSync(file, 'utf8').trim()
    if (!raw) return { ...DEFAULTS }
    let json: string
    if (safeStorage.isEncryptionAvailable()) {
      try {
        json = safeStorage.decryptString(Buffer.from(raw, 'base64'))
      } catch {
        json = raw
      }
    } else {
      json = raw
    }
    const parsed = JSON.parse(json) as Partial<CreateCharSecrets>
    return { ...DEFAULTS, ...parsed }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveCreateCharSecrets(patch: Partial<CreateCharSecrets>): CreateCharSecrets {
  const next = { ...loadCreateCharSecrets(), ...patch }
  const json = JSON.stringify(next)
  const payload =
    safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(json).toString('base64')
      : json
  fs.writeFileSync(secretsPath(), payload, 'utf8')
  return next
}

export function createCharConfigPublic() {
  const s = loadCreateCharSecrets()
  return {
    teamoApiBase: s.teamoApiBase,
    teamoModel: s.teamoModel,
    hasApiKey: Boolean(s.teamoApiKey),
    hasAdminToken: Boolean(s.adminSessionToken),
    adminEmailLocal: s.adminEmailLocal || '',
    adminAccountId: s.adminAccountId || '',
  }
}
