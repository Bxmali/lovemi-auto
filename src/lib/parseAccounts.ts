import type { AuthMode, ParsedImportLine } from '../types/email'

function sanitizeField(value: string): string {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .trim()
    .replace(/^["'`]+|["'`]+$/g, '')
    .replace(/[\r\n\t]+/g, '')
    .trim()
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * 支持：
 * - email:password
 * - email:password:refresh_token:client_id
 * - email:password:recovery@mail:refresh_token:client_id
 * 多行粘贴；忽略空行与 # 注释
 * refresh_token 本身可能含冒号：取首段邮箱、次段密码、末段 client_id，中间全部拼回 token
 */
export function parseAccountLines(raw: string): {
  accounts: ParsedImportLine[]
  errors: string[]
  warnings: string[]
} {
  const accounts: ParsedImportLine[] = []
  const errors: string[] = []
  const warnings: string[] = []
  const lines = raw.split(/\r?\n/)

  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return

    const parts = trimmed.split(':')
    if (parts.length < 2) {
      errors.push(`第 ${index + 1} 行：格式无效`)
      return
    }

    const email = sanitizeField(parts[0] || '')
    if (!email || !email.includes('@')) {
      errors.push(`第 ${index + 1} 行：邮箱无效`)
      return
    }

    if (parts.length === 2) {
      accounts.push({
        email,
        password: parts[1] ?? '',
        authMode: 'password',
      })
      return
    }

    if (parts.length >= 4) {
      const password = parts[1] ?? ''
      let clientId = sanitizeField(parts[parts.length - 1] || '')
      // 第三段若是恢复邮箱则跳过（token 不以 M. 开头的 @ 段）
      let tokenStart = 2
      if (parts.length >= 5 && parts[2]?.includes('@') && !/^M\./i.test(parts[2] || '')) {
        tokenStart = 3
      }
      let refreshToken = sanitizeField(parts.slice(tokenStart, -1).join(':'))

      // 末两段反了：…:clientId:refreshToken
      if (!UUID_RE.test(clientId) && UUID_RE.test(sanitizeField(parts[parts.length - 2] || ''))) {
        clientId = sanitizeField(parts[parts.length - 2] || '')
        refreshToken = sanitizeField(
          parts
            .slice(tokenStart, -2)
            .concat(parts[parts.length - 1] || '')
            .join(':'),
        )
        warnings.push(`第 ${index + 1} 行：已自动纠正 clientId / refreshToken 顺序`)
      } else if (UUID_RE.test(refreshToken) && !UUID_RE.test(clientId) && clientId.length > 40) {
        const tmp = clientId
        clientId = refreshToken
        refreshToken = tmp
        warnings.push(`第 ${index + 1} 行：已自动对调 refreshToken 与 clientId`)
      }

      if (refreshToken && clientId && !UUID_RE.test(clientId)) {
        warnings.push(
          `第 ${index + 1} 行：clientId 不像 UUID（${clientId.slice(0, 8)}…），检测可能失败`,
        )
      }
      if (refreshToken && refreshToken.length < 40) {
        warnings.push(
          `第 ${index + 1} 行：refresh_token 过短（${refreshToken.length}），可能被截断`,
        )
      }

      const authMode: AuthMode = refreshToken && clientId ? 'oauth_graph' : 'password'
      accounts.push({
        email,
        password,
        refreshToken: refreshToken || undefined,
        clientId: clientId || undefined,
        authMode,
      })
      return
    }

    errors.push(
      `第 ${index + 1} 行：字段数量不正确（需要 2 或 ≥4 段：email:pass:refresh:clientId）`,
    )
  })

  return { accounts, errors, warnings }
}

export function maskSecret(value?: string): string {
  if (!value) return '—'
  if (value.length <= 8) return '••••'
  return `${value.slice(0, 3)}••••${value.slice(-3)}`
}
