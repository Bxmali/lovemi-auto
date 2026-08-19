import { create } from 'zustand'

const STORAGE_KEY = 'lovemi.securityLogs'

export type LogSeverity = 'info' | 'low' | 'medium' | 'high'
export type LogSource = 'ai' | 'human'

export type SecurityLogEntry = {
  id: string
  title: string
  body: string
  severity: LogSeverity
  source: LogSource
  tags: string[]
  createdAt: string
  updatedAt?: string
}

const AI_SEED: Omit<SecurityLogEntry, 'id' | 'createdAt'>[] = [
  {
    title: '自动化注册会持有邮箱刷新令牌',
    body: 'Lovemi Auto 为了代收验证码，需要本机保存 Hotmail Graph refresh_token。令牌等同于邮箱读信权限：泄露可被用来读 OTP、劫持注册流。风险不在「注册接口」，而在令牌落盘与备份扩散。当前使用 macOS safeStorage 加密；仍应避免截图库存、勿把 accounts.enc 同步到公开网盘、勿在聊天里粘贴完整凭证行。',
    severity: 'high',
    source: 'ai',
    tags: ['凭证', 'Graph', '落盘'],
  },
  {
    title: '验证码窗口期可被旁路读走',
    body: '注册流程是：发码 → 读信 OTP → 提交 register。若同一邮箱的 refresh_token 已被他人持有，对方也能在窗口期内读到同一封 OTP。白名单/不限频只降低业务侧拦截，不降低「令牌共享」带来的账号抢注风险。建议：测试池专用邮箱、用完轮换、禁止多人共用同一批号。',
    severity: 'high',
    source: 'ai',
    tags: ['OTP', '竞态'],
  },
  {
    title: '站内密码由本机生成并明文存于加密库存',
    body: '自动注册会生成 ≥12 位 Lovemi 密码并写入 accounts.enc。解密后对本地进程可读。若设备被未授权访问或备份被解包，攻击者可同时拿到邮箱令牌与 Lovemi 密码。建议：仅在受信机器运行；退出前确认磁盘加密（FileVault）；不要把库存导出为明文 JSON。',
    severity: 'medium',
    source: 'ai',
    tags: ['密码', '库存'],
  },
  {
    title: '出站代理路径上的中间人面',
    body: '所有 Graph / api.lovemi.ai 请求经 VLESS 或本地 7890。若代理节点或本地 Clash 被劫持，可能窥探 HTTPS 元数据甚至在错误配置下注入。自动化批量放大了暴露面。建议：只用自建/可信节点；定期轮换订阅；不要把未知订阅 URL 写进设置。',
    severity: 'medium',
    source: 'ai',
    tags: ['代理', '出站'],
  },
  {
    title: '批量注册成功 ≠ 账号已完成风控画像',
    body: '白名单环境下可以高频发码注册，但线上真实用户行为、设备指纹、支付风控仍可能事后标记。自动化账号若直接用于支付/社区，可能触发二次核验或封禁。建议：测试环境与生产运营池隔离；不要把「能注册」当成「可上线运营」。',
    severity: 'low',
    source: 'ai',
    tags: ['风控', '运营'],
  },
  {
    title: '日志与 Toast 可能泄露邮箱标识',
    body: '探活/注册进度会显示完整邮箱。共享屏幕、录屏、远端协助时等于公开测试池标识。建议：对外演示用演示数据；真实库存操作时关闭录屏或打码。',
    severity: 'info',
    source: 'ai',
    tags: ['隐私', '演示'],
  },
]

function uid() {
  return crypto.randomUUID()
}

function load(): SecurityLogEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return seed()
    const parsed = JSON.parse(raw) as SecurityLogEntry[]
    if (!Array.isArray(parsed) || parsed.length === 0) return seed()
    return parsed
  } catch {
    return seed()
  }
}

function seed(): SecurityLogEntry[] {
  const now = Date.now()
  return AI_SEED.map((row, i) => ({
    ...row,
    id: `ai-seed-${i}`,
    createdAt: new Date(now - (AI_SEED.length - i) * 60_000).toISOString(),
  }))
}

function persist(entries: SecurityLogEntry[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    /* ignore */
  }
}

interface SecurityLogState {
  entries: SecurityLogEntry[]
  hydrated: boolean
  hydrate: () => void
  addHuman: (input: { title: string; body: string; severity: LogSeverity; tags?: string[] }) => void
  remove: (id: string) => void
  resetAiSeed: () => void
}

export const useSecurityLogStore = create<SecurityLogState>((set, get) => ({
  entries: [],
  hydrated: false,
  hydrate: () => {
    if (get().hydrated) return
    set({ entries: load(), hydrated: true })
  },
  addHuman: ({ title, body, severity, tags }) => {
    const entry: SecurityLogEntry = {
      id: uid(),
      title: title.trim(),
      body: body.trim(),
      severity,
      source: 'human',
      tags: tags?.filter(Boolean) || [],
      createdAt: new Date().toISOString(),
    }
    const entries = [entry, ...get().entries]
    persist(entries)
    set({ entries, hydrated: true })
  },
  remove: (id) => {
    const entries = get().entries.filter((e) => e.id !== id)
    persist(entries)
    set({ entries })
  },
  resetAiSeed: () => {
    const humans = get().entries.filter((e) => e.source === 'human')
    const entries = [...seed().filter((e) => e.source === 'ai'), ...humans].sort(
      (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
    )
    persist(entries)
    set({ entries, hydrated: true })
  },
}))
