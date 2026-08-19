import type { AuthMode, ParsedImportLine } from '../types/email'

/**
 * 支持：
 * - email:password
 * - email:password:refresh_token:client_id
 * 多行粘贴；忽略空行与 # 注释
 */
export function parseAccountLines(raw: string): {
  accounts: ParsedImportLine[]
  errors: string[]
} {
  const accounts: ParsedImportLine[] = []
  const errors: string[] = []
  const lines = raw.split(/\r?\n/)

  lines.forEach((line, index) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return

    const parts = trimmed.split(':')
    if (parts.length < 2) {
      errors.push(`第 ${index + 1} 行：格式无效`)
      return
    }

    const email = parts[0]?.trim()
    if (!email || !email.includes('@')) {
      errors.push(`第 ${index + 1} 行：邮箱无效`)
      return
    }

    if (parts.length === 2) {
      accounts.push({
        email,
        password: parts[1],
        authMode: 'password',
      })
      return
    }

    if (parts.length >= 4) {
      // refresh token 本身可能含冒号，取头尾固定字段
      const password = parts[1]
      const clientId = parts[parts.length - 1]
      const refreshToken = parts.slice(2, -1).join(':')
      const authMode: AuthMode =
        refreshToken && clientId ? 'oauth_graph' : 'password'
      accounts.push({
        email,
        password,
        refreshToken,
        clientId,
        authMode,
      })
      return
    }

    errors.push(`第 ${index + 1} 行：字段数量不正确（需要 2 或 4 段）`)
  })

  return { accounts, errors }
}

export function maskSecret(value?: string): string {
  if (!value) return '—'
  if (value.length <= 8) return '••••'
  return `${value.slice(0, 3)}••••${value.slice(-3)}`
}
