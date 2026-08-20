import { create } from 'zustand'
import type { AccountStatus, EmailAccount, LovemiRegStatus, ParsedImportLine } from '../types/email'

function uid() {
  return crypto.randomUUID()
}

function fromParsed(row: ParsedImportLine): EmailAccount {
  return {
    id: uid(),
    email: row.email,
    authMode: row.authMode,
    password: row.password,
    refreshToken: row.refreshToken,
    clientId: row.clientId,
    labels: [],
    status: 'idle',
    notes: '',
    createdAt: new Date().toISOString(),
    lovemiRegistered: false,
    lovemiRegStatus: 'none',
  }
}

function isDemoAccount(a: EmailAccount) {
  return a.id.startsWith('demo-') || a.email.endsWith('@example.com')
}

export const DEMO_ACCOUNTS: EmailAccount[] = Array.from({ length: 12 }, (_, i) => ({
  id: `demo-${i}`,
  email: `demo.user${String(i + 1).padStart(2, '0')}@example.com`,
  authMode: i % 3 === 0 ? 'oauth_graph' : 'password',
  labels: i % 2 === 0 ? ['lovemi-reg'] : ['备用'],
  status: (['idle', 'ready', 'cooling', 'error'] as AccountStatus[])[i % 4],
  notes: '',
  createdAt: new Date(Date.now() - i * 86400000).toISOString(),
  lastError: i % 4 === 3 ? '连接超时（演示）' : undefined,
  lovemiRegistered: i % 3 === 0,
  lovemiRegStatus: i % 3 === 0 ? 'registered' : 'none',
}))

export type ProbePatch = {
  email: string
  ok: boolean
  error?: string
  refreshToken?: string
  displayName?: string
  via?: string
}

interface EmailState {
  accounts: EmailAccount[]
  selectedId: string | null
  query: string
  statusFilter: AccountStatus | 'all'
  view: 'cards' | 'table'
  hydrated: boolean
  userMutated: boolean
  probing: boolean
  toast: string | null
  toastUntil: number | null
  setToast: (msg: string | null, durationMs?: number) => void
  setQuery: (q: string) => void
  setStatusFilter: (s: AccountStatus | 'all') => void
  setView: (v: 'cards' | 'table') => void
  select: (id: string | null) => void
  importRows: (rows: ParsedImportLine[]) => { count: number; ids: string[] }
  remove: (ids: string[]) => void
  clearDemo: () => void
  setStatus: (id: string, status: AccountStatus) => void
  markProbing: (ids: string[]) => void
  applyProbes: (results: ProbePatch[]) => { ok: number; fail: number }
  markLovemiRegistering: (ids: string[]) => void
  applyLovemiRegisters: (
    results: Array<{
      email: string
      ok: boolean
      error?: string
      password?: string
      sessionToken?: string
      userId?: string
    }>,
  ) => { ok: number; fail: number }
  applyLovemiLogins: (
    results: Array<{
      email: string
      ok: boolean
      error?: string
      sessionToken?: string
      userId?: string
    }>,
  ) => { ok: number; fail: number }
  applyLovemiPasswordResets: (
    results: Array<{
      email: string
      ok: boolean
      error?: string
      password?: string
      sessionToken?: string
      userId?: string
    }>,
  ) => { ok: number; fail: number }
  setLovemiStatus: (id: string, status: LovemiRegStatus, patch?: Partial<EmailAccount>) => void
  loadDemo: () => string
  hydrate: (accounts: EmailAccount[]) => void
  /** 强制用磁盘/外部结果替换内存（可覆盖已 hydrate） */
  replaceAccounts: (accounts: EmailAccount[]) => void
  setProbing: (v: boolean) => void
  persistable: () => EmailAccount[]
  /** 暂停自动落盘（外部脚本写盘后避免内存旧状态盖回去） */
  suspendPersist: boolean
  setSuspendPersist: (v: boolean) => void
  registering: boolean
  setRegistering: (v: boolean) => void
}

export const useEmailStore = create<EmailState>((set, get) => ({
  accounts: [],
  selectedId: null,
  query: '',
  statusFilter: 'all',
  view: 'cards',
  hydrated: false,
  userMutated: false,
  probing: false,
  registering: false,
  toast: null,
  toastUntil: null,
  suspendPersist: false,
  setQuery: (query) => set({ query }),
  setStatusFilter: (statusFilter) => set({ statusFilter }),
  setView: (view) => set({ view }),
  select: (selectedId) => set({ selectedId }),
  setToast: (toast, durationMs = 2400) =>
    set({
      toast,
      toastUntil: toast ? Date.now() + Math.max(800, durationMs) : null,
    }),
  setProbing: (probing) => set({ probing }),
  setRegistering: (registering) => set({ registering }),
  setSuspendPersist: (suspendPersist) => set({ suspendPersist }),
  importRows: (rows) => {
    const withoutDemo = get().accounts.filter((a) => !isDemoAccount(a))
    const existing = new Set(withoutDemo.map((a) => a.email.toLowerCase()))
    const fresh = rows
      .filter((r) => !existing.has(r.email.toLowerCase()))
      .map(fromParsed)
    set({
      accounts: [...fresh, ...withoutDemo],
      userMutated: true,
      hydrated: true,
      selectedId: null,
    })
    return { count: fresh.length, ids: fresh.map((a) => a.id) }
  },
  remove: (ids) => {
    const idSet = new Set(ids)
    set({
      accounts: get().accounts.filter((a) => !idSet.has(a.id)),
      selectedId: get().selectedId && idSet.has(get().selectedId!) ? null : get().selectedId,
      userMutated: true,
    })
  },
  clearDemo: () => {
    set({
      accounts: get().accounts.filter((a) => !isDemoAccount(a)),
      userMutated: true,
      selectedId: null,
    })
  },
  setStatus: (id, status) =>
    set({
      accounts: get().accounts.map((a) =>
        a.id === id
          ? { ...a, status, lastOkAt: status === 'ready' ? new Date().toISOString() : a.lastOkAt }
          : a,
      ),
      userMutated: true,
    }),
  markProbing: (ids) => {
    const idSet = new Set(ids)
    set({
      accounts: get().accounts.map((a) =>
        idSet.has(a.id) ? { ...a, status: 'cooling' as const, lastError: '检测中…' } : a,
      ),
      probing: true,
      userMutated: true,
    })
  },
  applyProbes: (results) => {
    const byEmail = new Map(results.map((r) => [r.email.toLowerCase(), r]))
    let ok = 0
    let fail = 0
    set({
      accounts: get().accounts.map((a) => {
        const r = byEmail.get(a.email.toLowerCase())
        if (!r) return a
        if (r.ok) {
          ok++
          return {
            ...a,
            status: 'ready' as const,
            lastOkAt: new Date().toISOString(),
            lastError: undefined,
            refreshToken: r.refreshToken || a.refreshToken,
            notes: [r.via ? `via:${r.via}` : '', r.displayName ? `Graph: ${r.displayName}` : '']
              .filter(Boolean)
              .join(' · ') || a.notes,
          }
        }
        fail++
        return {
          ...a,
          status: 'error' as const,
          lastError: r.error || '检测失败',
        }
      }),
      probing: false,
      userMutated: true,
    })
    return { ok, fail }
  },
  markLovemiRegistering: (ids) => {
    const idSet = new Set(ids)
    set({
      accounts: get().accounts.map((a) =>
        idSet.has(a.id)
          ? {
              ...a,
              lovemiRegStatus: 'registering' as const,
              lovemiRegError: undefined,
            }
          : a,
      ),
      registering: true,
      userMutated: true,
    })
  },
  applyLovemiRegisters: (results) => {
    const byEmail = new Map(results.map((r) => [r.email.toLowerCase(), r]))
    let ok = 0
    let fail = 0
    set({
      accounts: get().accounts.map((a) => {
        const r = byEmail.get(a.email.toLowerCase())
        if (!r) return a
        if (r.ok) {
          ok++
          return {
            ...a,
            lovemiRegistered: true,
            lovemiRegStatus: 'registered' as const,
            lovemiRegisteredAt: new Date().toISOString(),
            lovemiPassword: r.password || a.lovemiPassword,
            lovemiSessionToken: r.sessionToken || a.lovemiSessionToken,
            lovemiUserId: r.userId || a.lovemiUserId,
            lovemiTokenAt: r.sessionToken ? new Date().toISOString() : a.lovemiTokenAt,
            lovemiRegError: undefined,
            labels: (a.labels || []).filter((l) => !/^lovemi(-reg)?$/i.test(l)),
          }
        }
        fail++
        return {
          ...a,
          lovemiRegistered: false,
          lovemiRegStatus: 'failed' as const,
          lovemiRegError: r.error || '注册失败',
        }
      }),
      userMutated: true,
    })
    return { ok, fail }
  },
  applyLovemiLogins: (results) => {
    const byEmail = new Map(results.map((r) => [r.email.toLowerCase(), r]))
    let ok = 0
    let fail = 0
    set({
      accounts: get().accounts.map((a) => {
        const r = byEmail.get(a.email.toLowerCase())
        if (!r) return a
        if (r.ok && r.sessionToken) {
          ok++
          return {
            ...a,
            lovemiSessionToken: r.sessionToken,
            lovemiUserId: r.userId || a.lovemiUserId,
            lovemiTokenAt: new Date().toISOString(),
            lovemiRegError: undefined,
          }
        }
        fail++
        return {
          ...a,
          lovemiRegError: r.error || '登录取票失败',
        }
      }),
      userMutated: true,
    })
    return { ok, fail }
  },
  applyLovemiPasswordResets: (results) => {
    const byEmail = new Map(results.map((r) => [r.email.toLowerCase(), r]))
    let ok = 0
    let fail = 0
    set({
      accounts: get().accounts.map((a) => {
        const r = byEmail.get(a.email.toLowerCase())
        if (!r) return a
        if (r.ok && r.password) {
          ok++
          return {
            ...a,
            lovemiPassword: r.password,
            lovemiSessionToken: r.sessionToken || a.lovemiSessionToken,
            lovemiUserId: r.userId || a.lovemiUserId,
            lovemiTokenAt: r.sessionToken ? new Date().toISOString() : a.lovemiTokenAt,
            lovemiRegError: undefined,
            lovemiRegistered: true,
            lovemiRegStatus: 'registered' as const,
          }
        }
        fail++
        return {
          ...a,
          lovemiRegError: r.error || '重置密码失败',
        }
      }),
      userMutated: true,
    })
    return { ok, fail }
  },
  setLovemiStatus: (id, status, patch) =>
    set({
      accounts: get().accounts.map((a) =>
        a.id === id
          ? {
              ...a,
              ...patch,
              lovemiRegStatus: status,
              lovemiRegistered: status === 'registered' ? true : a.lovemiRegistered,
            }
          : a,
      ),
      userMutated: true,
    }),
  loadDemo: () => {
    const real = get().accounts.filter((a) => !isDemoAccount(a))
    if (real.length > 0) {
      return '已有真实账号，未覆盖。请先清空或仅用「导入账号」。'
    }
    set({
      accounts: DEMO_ACCOUNTS.map((a) => ({ ...a })),
      userMutated: true,
      hydrated: true,
      selectedId: null,
    })
    return '已载入演示数据'
  },
  hydrate: (accounts) => {
    if (get().hydrated || get().userMutated) return
    set({ accounts, hydrated: true })
  },
  replaceAccounts: (accounts) => {
    set({
      accounts,
      hydrated: true,
      userMutated: true,
      selectedId: null,
      probing: false,
    })
  },
  persistable: () => get().accounts.filter((a) => !isDemoAccount(a)),
}))

export function filterAccounts(
  accounts: EmailAccount[],
  query: string,
  statusFilter: AccountStatus | 'all',
): EmailAccount[] {
  const q = query.trim().toLowerCase()
  return accounts.filter((a) => {
    if (statusFilter !== 'all' && a.status !== statusFilter) return false
    if (!q) return true
    return (
      a.email.toLowerCase().includes(q) ||
      a.notes.toLowerCase().includes(q) ||
      a.labels.some((l) => l.toLowerCase().includes(q))
    )
  })
}
