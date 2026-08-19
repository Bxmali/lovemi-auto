export type AuthMode = 'password' | 'oauth_graph' | 'imap'
export type AccountStatus = 'idle' | 'ready' | 'cooling' | 'error' | 'disabled'

export type LovemiRegStatus = 'none' | 'registering' | 'registered' | 'failed'

export interface EmailAccount {
  id: string
  email: string
  authMode: AuthMode
  /** Never render in UI; only used in main/store */
  password?: string
  refreshToken?: string
  clientId?: string
  labels: string[]
  status: AccountStatus
  notes: string
  lastOkAt?: string
  lastError?: string
  createdAt: string
  /** 是否已在 Lovemi 完成邮箱注册 */
  lovemiRegistered?: boolean
  lovemiRegStatus?: LovemiRegStatus
  lovemiRegisteredAt?: string
  /** Lovemi 站内密码（与邮箱密码可能不同） */
  lovemiPassword?: string
  /** api.lovemi.ai Authorization Bearer（session_token） */
  lovemiSessionToken?: string
  lovemiUserId?: string
  lovemiTokenAt?: string
  lovemiRegError?: string
  /** 互动语言：决定用户名与评论语言 */
  lovemiLocale?: string
  /** 站内显示名（creator-profile.display_name） */
  lovemiDisplayName?: string
  /** 是否已完成语言分配 + 改名 */
  lovemiProfileReady?: boolean
}

export interface ParsedImportLine {
  email: string
  password?: string
  refreshToken?: string
  clientId?: string
  authMode: AuthMode
}
