import fs from 'node:fs'
import path from 'node:path'
import { app, safeStorage } from 'electron'
import {
  FEATURE_ASPECTS,
  FEATURE_MPS,
  isFeatureAspect,
  isFeatureMp,
  type FeatureAspect,
  type FeatureMp,
} from './featureImageSize'

export type CreateCharSecrets = {
  teamoApiBase: string
  teamoApiKey: string
  teamoModel: string
  /** 管理员 Lovemi Bearer（仅本地加密存储） */
  adminSessionToken?: string
  adminEmailLocal?: string
  adminAccountId?: string
  /** 推特资源父目录；其下自动建「推特资源」。空=系统 Downloads */
  downloadsDir?: string
  /** 导出推特资源时是否敲粉色水印；下载本身始终开启 */
  autoDownloadWatermark?: boolean
  /** 特色素材默认宽高比 */
  featureAspectRatio?: FeatureAspect
  /** 特色素材默认画质 MP */
  featureImageMp?: FeatureMp
}

const DEFAULTS: CreateCharSecrets = {
  teamoApiBase: 'https://api.teamorouter.com/v1',
  teamoApiKey: '',
  teamoModel: 'gpt-5.4-mini',
  autoDownloadWatermark: true,
  featureAspectRatio: '16:9',
  featureImageMp: 3,
}

function secretsPath() {
  return path.join(app.getPath('userData'), 'create-char.secrets')
}

/** 脱敏：skab***wxyz / eyJh***xxxx */
export function maskSecret(value: string | undefined, head = 4, tail = 4) {
  const s = (value || '').trim()
  if (!s) return ''
  if (s.length <= head + tail + 1) {
    if (s.length <= 4) return `${s.slice(0, 1)}***`
    return `${s.slice(0, 2)}***${s.slice(-2)}`
  }
  return `${s.slice(0, head)}***${s.slice(-tail)}`
}

function parseSecretsJson(text: string): Partial<CreateCharSecrets> | null {
  try {
    const parsed = JSON.parse(text) as Partial<CreateCharSecrets>
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

export function loadCreateCharSecrets(): CreateCharSecrets {
  try {
    const file = secretsPath()
    if (!fs.existsSync(file)) return { ...DEFAULTS }
    const raw = fs.readFileSync(file, 'utf8').trim()
    if (!raw) return { ...DEFAULTS }

    let parsed: Partial<CreateCharSecrets> | null = null
    if (safeStorage.isEncryptionAvailable()) {
      try {
        const decrypted = safeStorage.decryptString(Buffer.from(raw, 'base64'))
        parsed = parseSecretsJson(decrypted)
      } catch {
        // 换机/密钥不可用：若文件本身是明文 JSON 仍可读
        parsed = raw.startsWith('{') ? parseSecretsJson(raw) : null
      }
    } else {
      parsed = parseSecretsJson(raw)
    }
    if (!parsed) return { ...DEFAULTS }

    const next = { ...DEFAULTS, ...parsed }
    if (!isFeatureAspect(next.featureAspectRatio)) next.featureAspectRatio = DEFAULTS.featureAspectRatio
    if (!isFeatureMp(Number(next.featureImageMp))) {
      next.featureImageMp = DEFAULTS.featureImageMp
    } else {
      next.featureImageMp = Number(next.featureImageMp) as FeatureMp
    }
    return next
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveCreateCharSecrets(patch: Partial<CreateCharSecrets>): CreateCharSecrets {
  const current = loadCreateCharSecrets()
  const next: CreateCharSecrets = { ...current, ...patch }
  // 空字符串不覆盖已保存密钥（便于「留空沿用」）
  if (typeof patch.teamoApiKey === 'string' && !patch.teamoApiKey.trim()) {
    next.teamoApiKey = current.teamoApiKey
  }
  if (typeof patch.adminSessionToken === 'string' && !patch.adminSessionToken.trim()) {
    next.adminSessionToken = current.adminSessionToken
  }
  if (patch.featureAspectRatio != null && !isFeatureAspect(patch.featureAspectRatio)) {
    next.featureAspectRatio = current.featureAspectRatio || DEFAULTS.featureAspectRatio
  }
  if (patch.featureImageMp != null && !isFeatureMp(Number(patch.featureImageMp))) {
    next.featureImageMp = current.featureImageMp || DEFAULTS.featureImageMp
  } else if (patch.featureImageMp != null) {
    next.featureImageMp = Number(patch.featureImageMp) as FeatureMp
  }

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
  const aspect = isFeatureAspect(s.featureAspectRatio)
    ? s.featureAspectRatio
    : (DEFAULTS.featureAspectRatio as FeatureAspect)
  const mp = isFeatureMp(Number(s.featureImageMp))
    ? (Number(s.featureImageMp) as FeatureMp)
    : (DEFAULTS.featureImageMp as FeatureMp)
  return {
    teamoApiBase: s.teamoApiBase,
    teamoModel: s.teamoModel,
    hasApiKey: Boolean(s.teamoApiKey?.trim()),
    hasAdminToken: Boolean(s.adminSessionToken?.trim()),
    apiKeyMask: maskSecret(s.teamoApiKey),
    adminTokenMask: maskSecret(s.adminSessionToken),
    adminEmailLocal: s.adminEmailLocal || '',
    adminAccountId: s.adminAccountId || '',
    downloadsDir: (s.downloadsDir || '').trim(),
    autoDownloadWatermark: s.autoDownloadWatermark !== false,
    featureAspectRatio: aspect,
    featureImageMp: mp,
    featureAspectOptions: [...FEATURE_ASPECTS],
    featureMpOptions: [...FEATURE_MPS],
  }
}
